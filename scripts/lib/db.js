import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { personalizedPageRank, buildFileGraph } from './graph.js';
import {
  extractIdentifiers,
  prepareFTSQuery,
  normalizeBM25,
  rrfScore,
  getFileTypeMultiplier,
  getIdentifierBoost,
} from './tokenizer.js';

function float32Buffer(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

function decodeEmbedding(buf) {
  // Copy rather than view: the Buffer may sit at a non-zero offset inside a
  // pooled allocation, which a bare Float32Array view would misread.
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// sqlite-vec requires BigInt for primary key values
function toBigInt(val) {
  return typeof val === 'bigint' ? val : BigInt(val);
}

export const SCHEMA_VERSION = 3;

// A path prefix is a literal, but LIKE treats _ and % as wildcards — and
// underscores are ordinary in directory names, so --path src_gen/ silently
// matched src/gen/ as well. The vector half of a hybrid search filters with
// startsWith(), so without this the two halves applied different path filters.
function likePrefix(prefix) {
  return String(prefix).replace(/[\\%_]/g, c => '\\' + c) + '%';
}

export class BeaconDatabase {
  constructor(dbPath, dimensions) {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.dimensions = dimensions;
    this.init();
  }

  init() {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        file_hash TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(file_path, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    `);

    // Create vector table with cosine distance metric
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        chunk_id INTEGER PRIMARY KEY,
        embedding float[${this.dimensions}] distance_metric=cosine
      );
    `);

    // Migrate to schema v2: add identifiers column + FTS5 table
    this._migrateToV2();
    // Migrate to schema v3: symbol/reference tables for the file graph
    this._migrateToV3();
  }

  _migrateToV2() {
    const currentVersion = parseInt(this.getSyncState('schema_version') || '1', 10);
    // Guard on 2 specifically, not SCHEMA_VERSION: this backfills all of FTS,
    // so a later version bump must not drag it along and duplicate every row.
    if (currentVersion >= 2) return;

    // Add identifiers column if missing
    const cols = this.db.pragma('table_info(chunks)');
    const hasIdentifiers = cols.some(c => c.name === 'identifiers');
    if (!hasIdentifiers) {
      this.db.exec('ALTER TABLE chunks ADD COLUMN identifiers TEXT DEFAULT ""');
    }

    // Create FTS5 virtual table (content-synced with chunks table)
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        file_path,
        chunk_text,
        identifiers,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);

    // Backfill identifiers and populate FTS from existing chunks
    const allChunks = this.db.prepare('SELECT id, file_path, chunk_text FROM chunks').all();
    if (allChunks.length > 0) {
      const updateIds = this.db.prepare('UPDATE chunks SET identifiers = ? WHERE id = ?');
      const insertFts = this.db.prepare(
        'INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES (?, ?, ?, ?)'
      );

      const backfill = this.db.transaction(() => {
        for (const row of allChunks) {
          const ids = extractIdentifiers(row.chunk_text);
          updateIds.run(ids, row.id);
          insertFts.run(row.id, row.file_path, row.chunk_text, ids);
        }
      });
      backfill();
    }

    this.setSyncState('schema_version', '2');
  }

  // v3: symbol definitions and references, for the file reference graph.
  // No backfill is possible — definitions come from source text that the index
  // does not retain verbatim per file — so the tables start empty and the graph
  // signal simply contributes nothing until the next reindex.
  _migrateToV3() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        file_path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        line INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refs (
        file_path TEXT NOT NULL,
        name TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_path);
      CREATE INDEX IF NOT EXISTS idx_refs_name ON refs(name);
    `);
    const currentVersion = parseInt(this.getSyncState('schema_version') || '1', 10);
    if (currentVersion < 3) this.setSyncState('schema_version', '3');
  }

  /**
   * Replace every symbol and reference recorded for one file. Keyed on
   * file_path so it rides along with the existing per-file delete lifecycle.
   */
  replaceFileSymbols(filePath, definitions, references) {
    const tx = this.db.transaction((fp, defs, refs) => {
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(fp);
      this.db.prepare('DELETE FROM refs WHERE file_path = ?').run(fp);
      const insDef = this.db.prepare('INSERT INTO symbols (file_path, name, kind, line) VALUES (?, ?, ?, ?)');
      for (const d of defs) insDef.run(fp, d.name, d.kind, d.line | 0);
      const insRef = this.db.prepare('INSERT INTO refs (file_path, name) VALUES (?, ?)');
      for (const r of refs) insRef.run(fp, r);
    });
    tx(filePath, definitions || [], references || []);
  }

  /** Everything needed to build the file graph, in two queries. */
  getGraphData() {
    const refsByFile = new Map();
    for (const r of this.db.prepare('SELECT file_path, name FROM refs').all()) {
      let set = refsByFile.get(r.file_path);
      if (!set) { set = new Set(); refsByFile.set(r.file_path, set); }
      set.add(r.name);
    }
    const definitionsByName = new Map();
    for (const r of this.db.prepare('SELECT DISTINCT file_path, name FROM symbols').all()) {
      let arr = definitionsByName.get(r.name);
      if (!arr) { arr = []; definitionsByName.set(r.name, arr); }
      arr.push(r.file_path);
    }
    return { refsByFile, definitionsByName };
  }

  /** Files defining any of these symbol names. */
  filesDefining(names) {
    if (!names || names.length === 0) return [];
    const marks = names.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT DISTINCT file_path, name FROM symbols WHERE name IN (${marks})`
    ).all(...names);
  }

  /** Every place a symbol name is referenced. */
  referencesTo(name) {
    return this.db.prepare(
      'SELECT DISTINCT file_path FROM refs WHERE name = ? ORDER BY file_path'
    ).all(name).map(r => r.file_path);
  }

  /** Declared symbols in one file, in source order. */
  symbolsInFile(filePath) {
    return this.db.prepare(
      'SELECT name, kind, line FROM symbols WHERE file_path = ? ORDER BY line'
    ).all(filePath);
  }

  /** Files whose path contains this fragment — for resolving a partial path. */
  filesMatching(fragment) {
    return this.db.prepare(
      "SELECT DISTINCT file_path FROM chunks WHERE file_path LIKE ? ESCAPE '\\' ORDER BY file_path LIMIT 20"
    ).all('%' + String(fragment).replace(/[\\%_]/g, c => '\\' + c) + '%').map(r => r.file_path);
  }

  hasSymbolGraph() {
    try {
      return this.db.prepare('SELECT 1 FROM symbols LIMIT 1').get() !== undefined;
    } catch { return false; }
  }

  upsertChunk(filePath, chunkIndex, chunkText, startLine, endLine, embedding, fileHash, identifiers) {
    // If identifiers not provided, compute them
    if (identifiers === undefined || identifiers === null) {
      identifiers = extractIdentifiers(chunkText);
    }
    this._upsertTransaction(filePath, chunkIndex, chunkText, startLine, endLine, embedding, fileHash, identifiers);
  }

  _upsertTransaction = (() => {
    let tx = null;
    return (filePath, chunkIndex, chunkText, startLine, endLine, embedding, fileHash, identifiers) => {
      if (!tx) {
        tx = this.db.transaction((fp, ci, ct, sl, el, emb, fh, ids) => {
          const existing = this.db.prepare(
            'SELECT id FROM chunks WHERE file_path = ? AND chunk_index = ?'
          ).get(fp, ci);

          const embBuffer = float32Buffer(emb);

          if (existing) {
            // Delete old FTS row before update
            this.db.prepare(
              'INSERT INTO chunks_fts(chunks_fts, rowid, file_path, chunk_text, identifiers) VALUES(\'delete\', ?, ?, (SELECT chunk_text FROM chunks WHERE id = ?), (SELECT identifiers FROM chunks WHERE id = ?))'
            ).run(existing.id, fp, existing.id, existing.id);

            this.db.prepare(`
              UPDATE chunks SET chunk_text = ?, start_line = ?, end_line = ?,
              embedding = ?, file_hash = ?, identifiers = ?, updated_at = datetime('now')
              WHERE file_path = ? AND chunk_index = ?
            `).run(ct, sl, el, embBuffer, fh, ids, fp, ci);

            // Insert updated FTS row
            this.db.prepare(
              'INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES(?, ?, ?, ?)'
            ).run(existing.id, fp, ct, ids);

            this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(toBigInt(existing.id));
            this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(toBigInt(existing.id), embBuffer);
          } else {
            const result = this.db.prepare(`
              INSERT INTO chunks (file_path, chunk_index, chunk_text, start_line, end_line, embedding, file_hash, identifiers)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(fp, ci, ct, sl, el, embBuffer, fh, ids);

            // Insert FTS row
            this.db.prepare(
              'INSERT INTO chunks_fts(rowid, file_path, chunk_text, identifiers) VALUES(?, ?, ?, ?)'
            ).run(result.lastInsertRowid, fp, ct, ids);

            this.db.prepare('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(toBigInt(result.lastInsertRowid), embBuffer);
          }
        });
      }
      tx(filePath, chunkIndex, chunkText, startLine, endLine, embedding, fileHash, identifiers);
    };
  })();

  deleteFileChunks(filePath) {
    const deleteTransaction = this.db.transaction((fp) => {
      const rows = this.db.prepare('SELECT id, chunk_text, identifiers FROM chunks WHERE file_path = ?').all(fp);
      for (const row of rows) {
        // Delete FTS row
        this.db.prepare(
          'INSERT INTO chunks_fts(chunks_fts, rowid, file_path, chunk_text, identifiers) VALUES(\'delete\', ?, ?, ?, ?)'
        ).run(row.id, fp, row.chunk_text, row.identifiers || '');
        // Delete vector row
        this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(toBigInt(row.id));
      }
      this.db.prepare('DELETE FROM chunks WHERE file_path = ?').run(fp);
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(fp);
      this.db.prepare('DELETE FROM refs WHERE file_path = ?').run(fp);
    });
    deleteTransaction(filePath);
  }

  deleteOrphanChunks(filePath, maxChunkIndex) {
    const orphanTransaction = this.db.transaction((fp, maxIdx) => {
      const orphans = this.db.prepare(
        'SELECT id, chunk_text, identifiers FROM chunks WHERE file_path = ? AND chunk_index > ?'
      ).all(fp, maxIdx);
      for (const row of orphans) {
        // Delete FTS row
        this.db.prepare(
          'INSERT INTO chunks_fts(chunks_fts, rowid, file_path, chunk_text, identifiers) VALUES(\'delete\', ?, ?, ?, ?)'
        ).run(row.id, fp, row.chunk_text, row.identifiers || '');
        // Delete vector row
        this.db.prepare('DELETE FROM chunks_vec WHERE chunk_id = ?').run(toBigInt(row.id));
      }
      this.db.prepare('DELETE FROM chunks WHERE file_path = ? AND chunk_index > ?').run(fp, maxIdx);
    });
    orphanTransaction(filePath, maxChunkIndex);
  }

  search(queryEmbedding, topK, threshold, queryText, config, pathPrefix) {
    const hybrid = config?.search?.hybrid;

    // Fallback to pure vector search when hybrid is disabled or no config
    if (!hybrid?.enabled || !queryText) {
      return this._vectorSearch(queryEmbedding, topK, threshold, pathPrefix);
    }

    const wVec = hybrid.weight_vector ?? 0.4;
    const wBM25 = hybrid.weight_bm25 ?? 0.3;
    const wRRF = hybrid.weight_rrf ?? 0.3;
    const debug = hybrid.debug ?? false;

    // Stage 1: Parallel retrieval
    // Vector search — fetch extra candidates for re-ranking headroom
    const vecResults = this._vectorSearchRaw(queryEmbedding, topK * 2, pathPrefix);

    // FTS search (tiered: AND-first for 3+ token queries, OR fallback)
    const ftsQuery = prepareFTSQuery(queryText);
    let ftsResults = [];
    if (ftsQuery) {
      if (typeof ftsQuery === 'object' && ftsQuery.andQuery) {
        ftsResults = this._ftsSearch(ftsQuery.andQuery, topK * 2, pathPrefix);
        if (ftsResults.length === 0) {
          ftsResults = this._ftsSearch(ftsQuery.orQuery, topK * 2, pathPrefix);
        }
      } else {
        ftsResults = this._ftsSearch(ftsQuery, topK * 2, pathPrefix);
      }
    }

    // Stage 2: Score fusion — merge candidates into a map by chunk_id
    const candidates = new Map();

    vecResults.forEach((r, rank) => {
      candidates.set(r.id, {
        ...r,
        vecRank: rank + 1,
        vecSimilarity: r.similarity,
        ftsRank: null,
        bm25Score: null,
      });
    });

    ftsResults.forEach((r, rank) => {
      if (candidates.has(r.id)) {
        const existing = candidates.get(r.id);
        existing.ftsRank = rank + 1;
        existing.bm25Score = r.bm25Score;
      } else {
        candidates.set(r.id, {
          ...r,
          vecRank: null,
          vecSimilarity: null,
          ftsRank: rank + 1,
          bm25Score: r.bm25Score,
        });
      }
    });

    // Normalize BM25 scores
    const bm25Scores = [];
    const bm25Ids = [];
    for (const [id, c] of candidates) {
      if (c.bm25Score !== null) {
        bm25Scores.push(c.bm25Score);
        bm25Ids.push(id);
      }
    }
    const normalizedBM25 = normalizeBM25(bm25Scores);
    bm25Ids.forEach((id, i) => {
      candidates.get(id).bm25Normalized = normalizedBM25[i];
    });

    // Compute fused scores
    const scored = [];
    for (const [, c] of candidates) {
      const vecComponent = c.vecSimilarity !== null ? wVec * c.vecSimilarity : 0;
      const bm25Component = c.bm25Normalized !== undefined ? wBM25 * c.bm25Normalized : 0;
      const rrfComponent = wRRF * rrfScore(c.vecRank, c.ftsRank);

      let fusedScore = vecComponent + bm25Component + rrfComponent;

      // Stage 3: Re-rank with file type multiplier and identifier boost
      const fileMultiplier = getFileTypeMultiplier(c.filePath);
      const idBoost = getIdentifierBoost(queryText, c.chunkText);
      fusedScore *= fileMultiplier * idBoost;

      scored.push({
        filePath: c.filePath,
        chunkText: c.chunkText,
        startLine: c.startLine,
        endLine: c.endLine,
        similarity: c.vecSimilarity ?? 0,
        score: fusedScore,
        ...(debug ? {
          _debug: {
            vecRank: c.vecRank, ftsRank: c.ftsRank,
            vecSimilarity: c.vecSimilarity, bm25Normalized: c.bm25Normalized,
            fileMultiplier, idBoost, vecComponent, bm25Component, rrfComponent,
          }
        } : {}),
      });
    }

    // Symbol-graph reranking: promote files that the current best matches
    // structurally depend on. A function with no doc comment has almost no
    // natural-language surface, so no embedding will surface it directly — but
    // whatever calls it usually is retrievable, and sits one reference edge
    // away. Seeding PageRank on the top hits walks that edge.
    const wGraph = hybrid.weight_graph ?? 0;
    if (wGraph > 0 && scored.length > 0) {
      const ppr = this._graphRanks(scored, hybrid.graph_seeds ?? 5, hybrid.graph_damping);
      if (ppr.size > 0) {
        for (const s of scored) {
          const p = ppr.get(s.filePath);
          if (!p) continue;
          const graphBoost = 1 + wGraph * p;
          s.score *= graphBoost;
          if (s._debug) s._debug.graphBoost = graphBoost;
        }

        // Boosting alone can only reorder what retrieval already found. The
        // case this signal exists for — a function with no prose surface —
        // never enters the candidate pool at all, so it cannot be reordered
        // into view. Pull in the files the graph reaches that neither vector
        // nor keyword search returned, and let them compete on real similarity.
        const present = new Set(scored.map(s => s.filePath));
        const reached = [...ppr.entries()]
          .filter(([f, p]) => !present.has(f) && p >= (hybrid.graph_expand_min ?? 0.05))
          .sort((a, b) => b[1] - a[1])
          .slice(0, hybrid.graph_expand ?? 3);

        for (const [filePath, p] of reached) {
          for (const c of this._bestChunksFor(filePath, queryEmbedding, 1)) {
            scored.push({
              filePath: c.filePath,
              chunkText: c.chunkText,
              startLine: c.startLine,
              endLine: c.endLine,
              similarity: c.similarity,
              // Justified by structure, not by similarity — so it must be
              // exempt from the similarity floor below, which exists to drop
              // weak *semantic* matches. Expansion deliberately surfaces code
              // the embedding rates poorly; applying the floor here would
              // discard precisely what the graph was used to find.
              viaGraph: true,
              // Scored on the same scale as everything else: its own vector
              // similarity, then the same graph boost the others received.
              score: wVec * c.similarity * getFileTypeMultiplier(c.filePath)
                     * getIdentifierBoost(queryText, c.chunkText) * (1 + wGraph * p),
              ...(debug ? { _debug: { viaGraph: true, ppr: p, vecSimilarity: c.similarity } } : {}),
            });
          }
        }
      }
    }

    // File-frequency reranking: files with more matching chunks get a cumulative boost
    const fileHits = new Map();
    for (const s of scored) {
      fileHits.set(s.filePath, (fileHits.get(s.filePath) || 0) + 1);
    }
    for (const s of scored) {
      const hitCount = fileHits.get(s.filePath);
      if (hitCount > 1) {
        const freqBoost = Math.min(1 + 0.1 * (hitCount - 1), 1.5);
        s.score *= freqBoost;
        if (s._debug) s._debug.fileFreqBoost = freqBoost;
      }
    }

    // Sort by fused score descending, filter by threshold on similarity (if available), take top K
    return scored
      .sort((a, b) => b.score - a.score)
      .filter(r => r.viaGraph || r.similarity >= threshold || (r.similarity === 0 && r.score > 0))
      .map(({ viaGraph, ...r }) => r)
      .slice(0, topK);
  }

  // Pure vector search (backward-compatible return format)
  _vectorSearch(queryEmbedding, topK, threshold, pathPrefix) {
    const fetchLimit = pathPrefix ? topK * 4 : topK;
    const results = this.db.prepare(`
      SELECT
        chunks_vec.chunk_id,
        chunks_vec.distance,
        chunks.file_path,
        chunks.chunk_text,
        chunks.start_line,
        chunks.end_line
      FROM chunks_vec
      LEFT JOIN chunks ON chunks.id = chunks_vec.chunk_id
      WHERE chunks_vec.embedding MATCH ?
        AND k = ?
      ORDER BY chunks_vec.distance ASC
    `).all(float32Buffer(queryEmbedding), fetchLimit);

    let mapped = results
      .map(r => ({
        filePath: r.file_path,
        chunkText: r.chunk_text,
        startLine: r.start_line,
        endLine: r.end_line,
        similarity: 1 - r.distance
      }))
      .filter(r => r.similarity >= threshold);

    if (pathPrefix) {
      mapped = mapped.filter(r => r.filePath.startsWith(pathPrefix));
    }

    return mapped.slice(0, topK);
  }

  // Vector search returning raw data for fusion
  _vectorSearchRaw(queryEmbedding, limit, pathPrefix) {
    // sqlite-vec doesn't support WHERE clauses beyond MATCH/k, so we filter post-query
    // Fetch extra results when path-filtering to ensure enough candidates
    const fetchLimit = pathPrefix ? limit * 4 : limit;
    const results = this.db.prepare(`
      SELECT
        chunks_vec.chunk_id,
        chunks_vec.distance,
        chunks.id,
        chunks.file_path,
        chunks.chunk_text,
        chunks.start_line,
        chunks.end_line
      FROM chunks_vec
      LEFT JOIN chunks ON chunks.id = chunks_vec.chunk_id
      WHERE chunks_vec.embedding MATCH ?
        AND k = ?
      ORDER BY chunks_vec.distance ASC
    `).all(float32Buffer(queryEmbedding), fetchLimit);

    let mapped = results.map(r => ({
      id: r.id,
      filePath: r.file_path,
      chunkText: r.chunk_text,
      startLine: r.start_line,
      endLine: r.end_line,
      similarity: 1 - r.distance,
    }));

    if (pathPrefix) {
      mapped = mapped.filter(r => r.filePath.startsWith(pathPrefix));
    }

    return mapped.slice(0, limit);
  }

  // FTS5 search with BM25 scoring (column weights: chunk_text=10, identifiers=5, file_path=1)
  _ftsSearch(ftsQuery, limit, pathPrefix) {
    try {
      let results;
      if (pathPrefix) {
        results = this.db.prepare(`
          SELECT
            chunks.id,
            chunks.file_path,
            chunks.chunk_text,
            chunks.start_line,
            chunks.end_line,
            chunks_fts.rank AS bm25_rank
          FROM chunks_fts
          JOIN chunks ON chunks.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
            AND chunks.file_path LIKE ? ESCAPE '\\'
          ORDER BY chunks_fts.rank
          LIMIT ?
        `).all(ftsQuery, likePrefix(pathPrefix), limit);
      } else {
        results = this.db.prepare(`
          SELECT
            chunks.id,
            chunks.file_path,
            chunks.chunk_text,
            chunks.start_line,
            chunks.end_line,
            chunks_fts.rank AS bm25_rank
          FROM chunks_fts
          JOIN chunks ON chunks.id = chunks_fts.rowid
          WHERE chunks_fts MATCH ?
          ORDER BY chunks_fts.rank
          LIMIT ?
        `).all(ftsQuery, limit);
      }

      return results.map(r => ({
        id: r.id,
        filePath: r.file_path,
        chunkText: r.chunk_text,
        startLine: r.start_line,
        endLine: r.end_line,
        bm25Score: r.bm25_rank,
      }));
    } catch (err) {
      console.error(`Beacon: FTS query failed (${ftsQuery}): ${err.message}`);
      return [];
    }
  }

  // Built once per connection: a query-time rebuild would re-read every symbol
  // and reference row on each search.
  _fileGraph(damping) {
    const key = damping || 'sqrt';
    if (this._graphCacheKey === key && this._graphCache !== undefined) return this._graphCache;
    if (!this.hasSymbolGraph()) { this._graphCacheKey = key; this._graphCache = null; return null; }
    const { refsByFile, definitionsByName } = this.getGraphData();
    this._graphCacheKey = key;
    this._graphCache = buildFileGraph(refsByFile, definitionsByName, key);
    return this._graphCache;
  }

  /**
   * Personalized PageRank seeded on the strongest current matches, weighted by
   * their score so a marginal hit does not pull the walk as hard as a good one.
   */
  _graphRanks(scored, seedCount, damping) {
    const edges = this._fileGraph(damping);
    if (!edges || edges.size === 0) return new Map();

    const best = new Map();
    for (const s of scored) {
      const prev = best.get(s.filePath);
      if (prev === undefined || s.score > prev) best.set(s.filePath, s.score);
    }
    const seeds = new Map(
      [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, seedCount).filter(e => e[1] > 0)
    );
    if (seeds.size === 0) return new Map();
    return personalizedPageRank(edges, seeds);
  }

  /** Best chunks of one file against a query embedding, scored in JS. */
  _bestChunksFor(filePath, queryEmbedding, limit) {
    const rows = this.db.prepare(
      'SELECT chunk_text, start_line, end_line, embedding FROM chunks WHERE file_path = ?'
    ).all(filePath);
    return rows
      .map(r => ({
        filePath,
        chunkText: r.chunk_text,
        startLine: r.start_line,
        endLine: r.end_line,
        similarity: cosine(queryEmbedding, decodeEmbedding(r.embedding)),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  getIndexedFiles() {
    return this.db.prepare('SELECT DISTINCT file_path FROM chunks').all().map(r => r.file_path);
  }

  getFileHash(filePath) {
    const row = this.db.prepare('SELECT file_hash FROM chunks WHERE file_path = ? LIMIT 1').get(filePath);
    return row?.file_hash || null;
  }

  getSyncState(key) {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
    return row?.value || null;
  }

  setSyncState(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, String(value));
  }

  getStats() {
    const fileCount = this.db.prepare('SELECT COUNT(DISTINCT file_path) as n FROM chunks').get().n;
    const chunkCount = this.db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;
    return { fileCount, chunkCount };
  }

  getFileStats() {
    return this.db.prepare(`
      SELECT
        file_path,
        COUNT(*) as chunk_count,
        MAX(updated_at) as last_updated
      FROM chunks
      GROUP BY file_path
      ORDER BY last_updated DESC
    `).all().map(r => ({
      filePath: r.file_path,
      chunkCount: r.chunk_count,
      lastUpdated: r.last_updated
    }));
  }

  getDbSizeBytes() {
    const row = this.db.prepare(
      'SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()'
    ).get();
    return row?.size || 0;
  }

  getSyncProgress() {
    const rows = this.db.prepare(
      "SELECT key, value FROM sync_state WHERE key LIKE 'sync_%'"
    ).all();
    const result = {};
    for (const { key, value } of rows) {
      result[key] = value;
    }
    return result;
  }

  clearSyncProgress() {
    this.db.prepare(
      "DELETE FROM sync_state WHERE key IN ('sync_status', 'sync_total_files', 'sync_completed_files', 'sync_current_file', 'sync_started_at', 'sync_error')"
    ).run();
  }

  // Health check — opens DB read-only style, returns status object
  static healthCheck(dbPath, dimensions) {
    try {
      const db = new Database(dbPath, { readonly: true });
      sqliteVec.load(db);

      // Check chunks table exists
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'"
      ).get();
      if (!tableExists) {
        db.close();
        return { ok: false, fileCount: 0, chunkCount: 0, syncStatus: null, dimensionMismatch: false };
      }

      const fileCount = db.prepare('SELECT COUNT(DISTINCT file_path) as n FROM chunks').get().n;
      const chunkCount = db.prepare('SELECT COUNT(*) as n FROM chunks').get().n;

      const syncStatusRow = db.prepare("SELECT value FROM sync_state WHERE key = 'sync_status'").get();
      const syncStatus = syncStatusRow?.value || 'idle';

      // Check dimension mismatch
      const dimRow = db.prepare("SELECT value FROM sync_state WHERE key = 'embedding_dimensions'").get();
      const storedDimensions = dimRow ? parseInt(dimRow.value, 10) : null;
      const dimensionMismatch = storedDimensions !== null && storedDimensions !== dimensions;

      db.close();

      const ok = fileCount > 0 && syncStatus !== 'error' && !dimensionMismatch;
      return { ok, fileCount, chunkCount, syncStatus, dimensionMismatch };
    } catch {
      return { ok: false, fileCount: 0, chunkCount: 0, syncStatus: null, dimensionMismatch: false };
    }
  }

  // FTS-only search — no embeddings needed
  ftsOnlySearch(queryText, topK, pathPrefix) {
    const ftsQuery = prepareFTSQuery(queryText);
    if (!ftsQuery) return [];

    let ftsResults;
    if (typeof ftsQuery === 'object' && ftsQuery.andQuery) {
      ftsResults = this._ftsSearch(ftsQuery.andQuery, topK * 2, pathPrefix);
      if (ftsResults.length === 0) {
        ftsResults = this._ftsSearch(ftsQuery.orQuery, topK * 2, pathPrefix);
      }
    } else {
      ftsResults = this._ftsSearch(ftsQuery, topK * 2, pathPrefix);
    }
    if (ftsResults.length === 0) return [];

    // Normalize BM25 scores
    const bm25Scores = ftsResults.map(r => r.bm25Score);
    const normalized = normalizeBM25(bm25Scores);

    // Score with file-type multiplier and identifier boost
    const scored = ftsResults.map((r, i) => {
      let score = normalized[i];
      score *= getFileTypeMultiplier(r.filePath);
      score *= getIdentifierBoost(queryText, r.chunkText);
      return {
        filePath: r.filePath,
        chunkText: r.chunkText,
        startLine: r.startLine,
        endLine: r.endLine,
        similarity: 0,
        score,
        _note: 'FTS-only result (embedding server unavailable)',
      };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  // Check if stored dimensions match current config
  checkDimensions() {
    const stored = this.getSyncState('embedding_dimensions');
    if (stored === null) return { ok: true, stored: null, current: this.dimensions };
    const storedNum = parseInt(stored, 10);
    return { ok: storedNum === this.dimensions, stored: storedNum, current: this.dimensions };
  }

  // Store current dimensions in sync_state
  storeDimensions() {
    this.setSyncState('embedding_dimensions', String(this.dimensions));
  }

  close() {
    this.db.close();
  }
}
