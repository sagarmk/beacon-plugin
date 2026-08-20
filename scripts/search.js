#!/usr/bin/env node
// Called by: /search-code command and code-explorer agent
// Input: [--top-k N] [--threshold F] "<query1>" ["<query2>" ...]
// Output: JSON array (single query, backwards compatible) or array of {query, matches} (multiple queries)

import { openDatabase } from './lib/open-db.js';
import { Embedder } from './lib/embedder.js';
import { loadConfig } from './lib/config.js';
import { existsSync } from 'fs';
import path from 'path';

// Parse flags and queries from argv
const args = process.argv.slice(2);
let topKOverride = null;
let thresholdOverride = null;
let pathPrefix = null;
const queries = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--top-k' && args[i + 1]) {
    topKOverride = parseInt(args[++i], 10);
  } else if (args[i] === '--threshold' && args[i + 1]) {
    thresholdOverride = parseFloat(args[++i]);
  } else if (args[i] === '--path' && args[i + 1]) {
    pathPrefix = args[++i];
  } else if (args[i] === '--no-hybrid') {
    // handled after config load
  } else {
    queries.push(args[i]);
  }
}

if (queries.length === 0) {
  console.error('Usage: search.js [--top-k N] [--threshold F] "<query1>" ["<query2>" ...]');
  process.exit(1);
}

const config = loadConfig();
if (args.includes('--no-hybrid')) {
  config.search.hybrid = { ...config.search.hybrid, enabled: false };
}
const topK = topKOverride ?? config.search.top_k;
const threshold = thresholdOverride ?? config.search.similarity_threshold;

/**
 * Merge adjacent or overlapping chunk results from the same file into single entries.
 * Takes formatted matches (with file, lines, similarity, score, preview).
 */
function mergeAdjacentChunks(matches) {
  if (matches.length <= 1) return matches;

  // Sort by file then start line for grouping
  const sorted = matches.map(m => {
    const [start, end] = m.lines.split('-').map(Number);
    return { ...m, _start: start, _end: end };
  }).sort((a, b) => a.file.localeCompare(b.file) || a._start - b._start);

  const merged = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    // Merge if same file and adjacent/overlapping (within 5 lines gap)
    if (next.file === current.file && next._start <= current._end + 5) {
      // Sorting is by start line, so `current` is merely the EARLIER chunk, not
      // the better one — keeping its preview showed the wrong snippet whenever
      // the later chunk was the actual match. Pick by score.
      const better = parseFloat(next.score ?? next.similarity) > parseFloat(current.score ?? current.similarity) ? next : current;
      current = {
        ...current,
        _end: Math.max(current._end, next._end),
        lines: `${current._start}-${Math.max(current._end, next._end)}`,
        score: current.score !== undefined ? String(Math.max(parseFloat(current.score), parseFloat(next.score)).toFixed(3)) : current.score,
        similarity: String(Math.max(parseFloat(current.similarity), parseFloat(next.similarity)).toFixed(3)),
        preview: better.preview,
        ...(better._debug ? { _debug: better._debug } : {}),
      };
    } else {
      const { _start, _end, ...clean } = current;
      merged.push(clean);
      current = next;
    }
  }
  const { _start, _end, ...clean } = current;
  merged.push(clean);

  // Re-sort by score descending
  return merged.sort((a, b) => parseFloat(b.score || b.similarity) - parseFloat(a.score || a.similarity));
}

const dbPath = path.join(config.storage.path, 'embeddings.db');
if (!existsSync(dbPath)) {
  console.error('Beacon: no index found. Run sync first or start a new Claude Code session.');
  process.exit(1);
}

// Safe DB init
let db;
try {
  db = openDatabase(dbPath, config.embedding.dimensions);
} catch (err) {
  console.error(JSON.stringify({ error: `Failed to open database: ${err.message}. Try /reindex.` }));
  process.exit(1);
}

try {
  // Dimension check
  const dimCheck = db.checkDimensions();
  if (!dimCheck.ok) {
    console.error(JSON.stringify({
      error: `Dimension mismatch: DB has ${dimCheck.stored}d embeddings but config specifies ${dimCheck.current}d. Run /reindex to rebuild.`
    }));
    process.exit(1);
  }

  const embedder = new Embedder(config);

  // Try embedding — fall back to FTS-only if server is down
  let embeddings;
  let ftsOnly = false;
  try {
    embeddings = await embedder.embedQueries(queries);
  } catch (err) {
    console.error(`Beacon: embedding server unavailable (${err.message}), falling back to FTS-only search.`);
    ftsOnly = true;
  }

  if (ftsOnly) {
    // FTS-only fallback
    const results = queries.map(query => ({
      query,
      matches: mergeAdjacentChunks(db.ftsOnlySearch(query, topK, pathPrefix).map(r => ({
        file: r.filePath,
        lines: `${r.startLine}-${r.endLine}`,
        similarity: '0.000',
        ...(r.score !== undefined ? { score: r.score.toFixed(3) } : {}),
        preview: r.chunkText.slice(0, 300),
        _note: r._note,
      })))
    }));

    if (queries.length === 1) {
      console.log(JSON.stringify(results[0].matches, null, 2));
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  } else {
    // Normal hybrid/vector search
    const results = queries.map((query, i) => ({
      query,
      matches: mergeAdjacentChunks(db.search(embeddings[i], topK, threshold, query, config, pathPrefix).map(r => ({
        file: r.filePath,
        lines: `${r.startLine}-${r.endLine}`,
        similarity: r.similarity.toFixed(3),
        ...(r.score !== undefined ? { score: r.score.toFixed(3) } : {}),
        preview: r.chunkText.slice(0, 300),
        // hybrid.debug scoring breakdown was computed and then silently dropped
        // here, so the debug flag produced nothing through the CLI
        ...(r._debug ? { _debug: r._debug } : {}),
      })))
    }));

    // Single query → flat array (backwards compatible); multi-query → grouped by query
    if (queries.length === 1) {
      console.log(JSON.stringify(results[0].matches, null, 2));
    } else {
      console.log(JSON.stringify(results, null, 2));
    }
  }
} catch (err) {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
} finally {
  db?.close();
}
