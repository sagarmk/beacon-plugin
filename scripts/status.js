#!/usr/bin/env node
// Called by: /index-status command and PreCompact hook
// Flags: --compact-warning (minimal output for PreCompact injection)

import { openDatabase } from './lib/open-db.js';
import { loadConfig } from './lib/config.js';
import { existsSync } from 'fs';
import path from 'path';

const config = loadConfig();
const dbPath = path.join(config.storage.path, 'embeddings.db');

if (!existsSync(dbPath)) {
  console.log('Beacon: no index found yet. It will be created on next session start.');
  process.exit(0);
}

// Safe DB init
let db;
try {
  db = openDatabase(dbPath, config.embedding.dimensions);
} catch (err) {
  if (process.argv.includes('--compact-warning')) {
    console.log('Beacon: index unavailable (database error). Prefer grep for code search.');
  } else {
    console.log(JSON.stringify({ error: `Failed to open database: ${err.message}` }, null, 2));
  }
  process.exit(0);
}

try {
  const stats = db.getStats();
  const lastSync = db.getSyncState('last_sync_time');

  if (process.argv.includes('--compact-warning')) {
    // Health-aware prescriptive output for PreCompact
    const syncProgress = db.getSyncProgress();
    const syncStatus = syncProgress.sync_status || 'idle';

    if (syncStatus === 'error' || stats.fileCount === 0) {
      const reason = syncStatus === 'error'
        ? (syncProgress.sync_error || 'unknown error')
        : 'empty index';
      console.log(`Beacon: index unavailable (${reason}). Use grep for code search. Run /reindex to rebuild.`);
    } else if (syncStatus === 'in_progress') {
      const completed = syncProgress.sync_completed_files || '?';
      const total = syncProgress.sync_total_files || '?';
      console.log(`Beacon: indexing ${completed}/${total} files — search results may be incomplete until sync finishes.`);
    } else {
      // Healthy — remind Claude to prefer Beacon
      const pluginRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
      // Injected after compaction, so it has to restate the tools rather than
      // assume the earlier session context survived.
      console.log(`Beacon: code index active (${stats.fileCount} files, ${stats.chunkCount} chunks). Prefer the Beacon MCP tools over grep/cat: find_symbol(name) for where a symbol is defined, find_references(name) for every call site (exhaustive), outline(file) for a file's symbols, search_code(query) to find code by description. Grep is still right for literal text, regex, and anything outside the index. CLI fallback: node ${pluginRoot}/scripts/search.js "<query>".`);
    }
  } else {
    // Full status for /index-status command
    console.log(JSON.stringify({
      files_indexed: stats.fileCount,
      total_chunks: stats.chunkCount,
      last_sync: lastSync,
      db_path: dbPath,
      embedding_model: config.embedding.model,
      embedding_endpoint: config.embedding.api_base
    }, null, 2));
  }
} finally {
  db?.close();
}
