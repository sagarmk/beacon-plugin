#!/usr/bin/env node
// Called by: PostToolUse hook on Bash (after git checkout, rm, mv, etc.)
// Purpose: detect deleted files and remove their embeddings

import { openDatabase } from './lib/open-db.js';
import { loadConfig } from './lib/config.js';
import { resolveRepoPath } from './lib/git.js';
import { existsSync } from 'fs';
import path from 'path';

const config = loadConfig();
const dbPath = path.join(config.storage.path, 'embeddings.db');
if (!existsSync(dbPath)) process.exit(0);

// Safe DB init
let db;
try {
  db = openDatabase(dbPath, config.embedding.dimensions);
} catch (err) {
  console.error(`Beacon: gc failed to open database: ${err.message}`);
  process.exit(0);
}

try {
  // Debounce: skip if last GC was < 60s ago
  const lastGc = db.getSyncState('last_gc_time');
  if (lastGc && (Date.now() - new Date(lastGc).getTime()) < 60_000) {
    process.exit(0);
  }

  const indexedFiles = db.getIndexedFiles();
  let removed = 0;

  for (const filePath of indexedFiles) {
    // Paths in the index are repo-relative. Testing them against the CWD meant
    // that running gc from any subdirectory found every file "missing" and
    // deleted the entire index.
    if (!existsSync(resolveRepoPath(filePath))) {
      db.deleteFileChunks(filePath);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`Beacon: garbage collected ${removed} deleted files from index`);
  }

  db.setSyncState('last_gc_time', new Date().toISOString());
} finally {
  db?.close();
}
