#!/usr/bin/env node
// Called by: SessionStart hook (async)
// Purpose: full index on first run, diff-based catch-up on subsequent runs

import { openDatabase } from './lib/open-db.js';
import { Embedder } from './lib/embedder.js';
import { chunkCode } from './lib/chunker.js';
import { loadConfig } from './lib/config.js';
import { getRepoFiles, getFileHash, getModifiedFilesSince, resolveRepoPath, isGitRepo } from './lib/git.js';
import { shouldIndex } from './lib/ignore.js';
import { extractIdentifiers } from './lib/tokenizer.js';
import { extractDefinitions, extractReferences } from './lib/symbols.js';
import { isCwdBlacklisted, isCwdWhitelisted } from './lib/safety.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';

// Safety: refuse to index blacklisted paths
if (isCwdBlacklisted()) {
  console.error('Beacon: refusing to index — current directory is blacklisted. Run /blacklist to manage.');
  process.exit(0);
}

const config = loadConfig();
const forced = process.argv.includes('--force');

// Auto-index check (skip if called with --force from /run-indexer)
if (!forced && config.indexing.auto_index === false) {
  console.log('Beacon: auto-index is off. Use /run-indexer to index manually.');
  process.exit(0);
}

// Only auto-index actual projects. Without this, starting a session anywhere —
// a home directory, Documents, Downloads — silently recursively walked and
// embedded the lot, because the blacklist only ever matched the cwd exactly and
// so never covered anything beneath a blacklisted path. A git repo is the
// signal that a directory is a project someone means to index; /run-indexer
// (--force) and the whitelist stay available for projects that are not.
if (!forced && !isGitRepo() && !isCwdWhitelisted()) {
  console.log('Beacon: not a git repository — skipping auto-index.');
  console.log('Beacon: use /run-indexer to index it anyway, or /whitelist to always index it.');
  process.exit(0);
}

const dbDir = path.resolve(config.storage.path);
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

// PID file for /terminate-indexer
const pidFile = path.join(dbDir, 'sync.pid');

function writePidFile() {
  writeFileSync(pidFile, String(process.pid));
}

function deletePidFile() {
  try { unlinkSync(pidFile); } catch { /* already gone */ }
}

// Write PID file on start, delete on exit/signal
writePidFile();
process.on('SIGTERM', () => { deletePidFile(); process.exit(0); });
process.on('SIGINT', () => { deletePidFile(); process.exit(0); });
process.on('exit', () => { deletePidFile(); });

// Safe DB init
let db;
try {
  db = openDatabase(path.join(dbDir, 'embeddings.db'), config.embedding.dimensions);
} catch (err) {
  console.error(`Beacon: failed to open database: ${err.message}`);
  deletePidFile();
  process.exit(1);
}

// Stale state auto-recovery: if sync was in_progress and started >5 min ago, clear it
const staleProgress = db.getSyncProgress();
if (staleProgress.sync_status === 'in_progress' && staleProgress.sync_started_at) {
  const elapsed = Date.now() - new Date(staleProgress.sync_started_at).getTime();
  if (elapsed < 0 || elapsed > 5 * 60 * 1000) {
    console.log('Beacon: clearing stale sync state (previous sync timed out or was killed).');
    db.clearSyncProgress();
    db.setSyncState('sync_status', 'idle');
  }
}

// Dimension mismatch detection
const dimCheck = db.checkDimensions();
if (!dimCheck.ok) {
  console.error(`Beacon: dimension mismatch — DB has ${dimCheck.stored}d embeddings but config specifies ${dimCheck.current}d.`);
  console.error('Beacon: run /reindex to rebuild with the new dimensions.');
  db.setSyncState('sync_status', 'error');
  db.setSyncState('sync_error', `Dimension mismatch: stored=${dimCheck.stored}, config=${dimCheck.current}`);
  db.close();
  deletePidFile();
  process.exit(0); // exit 0 — don't block the session for a config issue
}

const embedder = new Embedder(config);

// Health check — is the embedding endpoint reachable?
const health = await embedder.ping();
if (!health.ok) {
  console.error(`Beacon: embedding endpoint unreachable (${config.embedding.api_base}): ${health.error}`);
  console.error('Beacon: skipping sync. Check your .claude/beacon.json config or start your LiteLLM proxy.');
  db.setSyncState('sync_status', 'error');
  db.setSyncState('sync_error', `Embedding endpoint unreachable: ${health.error}`);
  db.close();
  deletePidFile();
  process.exit(0); // exit 0 — don't block the session when embedder is down
}

try {
  // Record start time before fetching changed files — ensures files modified during sync
  // are picked up on the next incremental run (not missed by the timestamp window)
  const syncStartTime = new Date().toISOString();

  // Mark sync as in-progress
  db.setSyncState('sync_status', 'in_progress');
  db.setSyncState('sync_started_at', syncStartTime);

  const stats = db.getStats();
  const lastSyncTime = db.getSyncState('last_sync_time');

  const concurrency = config.indexing.concurrency || 4;

  // Branch on whether the initial index ever FINISHED, not on whether any rows
  // exist. A first index that was killed partway (closing the session during
  // the first sync of a big repo — the normal case, not an edge case) leaves
  // rows behind but no last_sync_time, and the incremental branch would then
  // find nothing to do and report "up to date" forever, with the repo only
  // partly indexed and search silently answering from the half it has.
  const initialDone = db.getSyncState('initial_index_complete') === '1';

  if (!initialDone) {
    // ── FIRST RUN (or an interrupted one): full index ──
    const maxFiles = config.indexing.max_files || 10000;
    const allFiles = getRepoFiles(maxFiles).filter(f => shouldIndex(f, config));

    // Resume cheaply: anything already embedded at its current hash is skipped,
    // so a killed index picks up roughly where it stopped instead of re-paying
    // for the whole repo.
    const pending = allFiles.filter(f => {
      try { return getFileHash(f) !== db.getFileHash(f); } catch { return true; }
    });
    const done = allFiles.length - pending.length;

    console.log(done > 0
      ? `Beacon: resuming interrupted index — ${done} file(s) already done, ${pending.length} to go...`
      : 'Beacon: first run detected — indexing entire repo...');

    db.setSyncState('sync_total_files', String(pending.length));
    db.setSyncState('sync_completed_files', '0');

    const result = await indexFilesConcurrently(pending, concurrency);

    if (result.failed > 0) console.warn(`Beacon: ${result.failed} file(s) failed to index.`);
    // Only call the initial index complete when nothing was left behind —
    // otherwise the failures are retried next session rather than written off.
    if (result.failed === 0) db.setSyncState('initial_index_complete', '1');
    else console.warn('Beacon: initial index incomplete — will retry the failures next session.');

    console.log(`Beacon: initial index complete — ${db.getStats().fileCount} files, ${db.getStats().chunkCount} chunks`);
  } else {
    // ── INCREMENTAL SYNC: only changed files ──
    const changedFiles = lastSyncTime
      ? getModifiedFilesSince(lastSyncTime).filter(f => shouldIndex(f, config))
      : [];

    if (changedFiles.length === 0) {
      console.log(`Beacon: index up to date (${stats.fileCount} files, ${stats.chunkCount} chunks)`);
    } else {
      console.log(`Beacon: syncing ${changedFiles.length} changed files...`);

      // Handle deletions synchronously, collect files needing re-index
      const toIndex = [];
      for (const filePath of changedFiles) {
        if (!existsSync(resolveRepoPath(filePath))) {
          db.deleteFileChunks(filePath);
        } else {
          const currentHash = getFileHash(filePath);
          const indexedHash = db.getFileHash(filePath);
          if (currentHash !== indexedHash) {
            toIndex.push(filePath);
          }
        }
      }

      db.setSyncState('sync_total_files', String(toIndex.length));
      db.setSyncState('sync_completed_files', '0');

      const result = await indexFilesConcurrently(toIndex, concurrency);

      if (result.failed > 0) console.warn(`Beacon: ${result.failed} file(s) failed to sync.`);
      console.log(`Beacon: sync complete — ${changedFiles.length} files processed (${result.indexed} re-indexed)`);
    }
  }

  // Sync finished successfully — clear progress, then write explicit 'idle' status
  // (clearSyncProgress deletes sync_status, so we must re-set it explicitly)
  db.clearSyncProgress();
  db.setSyncState('sync_status', 'idle');
  db.setSyncState('last_sync_time', syncStartTime);
  db.storeDimensions();

} catch (err) {
  // Track error state so /index can report it
  console.error(`Beacon: sync failed: ${err.message}`);
  db.setSyncState('sync_status', 'error');
  db.setSyncState('sync_error', err.message);
} finally {
  db.close();
  deletePidFile();
}

// ── Helpers ──

/**
 * Prepare a file for indexing: read, chunk, and extract metadata.
 * Returns null if the file has no chunks (e.g., empty or binary).
 */
function prepareFile(filePath) {
  const content = readFileSync(resolveRepoPath(filePath), 'utf-8');
  const fileHash = getFileHash(filePath);
  const chunks = chunkCode(content, filePath, config);
  if (chunks.length === 0) return null;
  // Symbols come from the whole file, not per chunk — the graph is file-level,
  // and a definition split across a chunk boundary would otherwise be lost.
  const definitions = extractDefinitions(content, filePath);
  const references = extractReferences(content, filePath, definitions.map(d => d.name));
  return { filePath, fileHash, chunks, definitions, references };
}

/**
 * Write embedded chunks to DB (serialized — no concurrent DB writes).
 */
function commitFileToDb(prepared, embeddings, startIdx) {
  for (let i = 0; i < prepared.chunks.length; i++) {
    const identifiers = extractIdentifiers(prepared.chunks[i].text);
    db.upsertChunk(
      prepared.filePath,
      prepared.chunks[i].index,
      prepared.chunks[i].text,
      prepared.chunks[i].startLine,
      prepared.chunks[i].endLine,
      embeddings[startIdx + i],
      prepared.fileHash,
      identifiers
    );
  }
  db.deleteOrphanChunks(prepared.filePath, prepared.chunks.length - 1);
  db.replaceFileSymbols(prepared.filePath, prepared.definitions, prepared.references);
}

/**
 * Process files concurrently: N files prepare in parallel, chunks batched across files
 * for efficient embedding API calls, DB writes serialized.
 */
async function indexFilesConcurrently(files, concurrency) {
  let indexed = 0;
  let failed = 0;
  const batchSize = config.embedding.batch_size || 10;

  // Process in concurrent windows
  for (let i = 0; i < files.length; i += concurrency) {
    const window = files.slice(i, i + concurrency);

    // Prepare files in parallel (read + chunk — CPU-bound, fast)
    const preparedResults = await Promise.allSettled(
      window.map(fp => {
        try {
          db.setSyncState('sync_current_file', fp);
          return Promise.resolve(prepareFile(fp));
        } catch (err) {
          return Promise.reject(err);
        }
      })
    );

    // Collect successful preparations, track failures
    const prepared = [];
    for (let j = 0; j < preparedResults.length; j++) {
      if (preparedResults[j].status === 'rejected') {
        console.error(`Beacon: failed to prepare ${window[j]}: ${preparedResults[j].reason?.message}`);
        failed++;
      } else if (preparedResults[j].value !== null) {
        prepared.push(preparedResults[j].value);
      } else {
        indexed++; // empty file, counts as processed
      }
    }

    if (prepared.length === 0) continue;

    // Cross-file batching: accumulate all chunk texts across files
    const allTexts = [];
    const fileOffsets = []; // {prepared, startIdx}
    for (const p of prepared) {
      fileOffsets.push({ prepared: p, startIdx: allTexts.length });
      allTexts.push(...p.chunks.map(c => c.text));
    }

    // Embed all chunks in one batched call (embedder handles internal sub-batching)
    try {
      const allEmbeddings = await embedder.embedDocuments(allTexts);

      // Commit to DB (serialized writes)
      for (const { prepared: p, startIdx } of fileOffsets) {
        commitFileToDb(p, allEmbeddings, startIdx);
        indexed++;
      }
    } catch (err) {
      // If the cross-file batch fails, retry files individually
      console.warn(`Beacon: batch embedding failed, retrying individually: ${err.message}`);
      for (const p of prepared) {
        try {
          const texts = p.chunks.map(c => c.text);
          const embeddings = await embedder.embedDocuments(texts);
          commitFileToDb(p, embeddings, 0);
          indexed++;
        } catch (innerErr) {
          console.error(`Beacon: failed to index ${p.filePath}: ${innerErr.message}`);
          failed++;
        }
      }
    }

    db.setSyncState('sync_completed_files', String(indexed + failed));
    if ((indexed + failed) % 50 === 0 || i + concurrency >= files.length) {
      console.log(`Beacon: indexed ${indexed}/${files.length} files...`);
    }
  }

  return { indexed, failed };
}
