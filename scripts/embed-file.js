#!/usr/bin/env node
// Called by: PostToolUse hook on Write|Edit|MultiEdit
// Input: $TOOL_INPUT_file_path (single file path)
// Purpose: re-embed one file — fast, runs on every edit

import { openDatabase } from './lib/open-db.js';
import { Embedder } from './lib/embedder.js';
import { chunkCode } from './lib/chunker.js';
import { loadConfig } from './lib/config.js';
import { shouldIndex } from './lib/ignore.js';
import { getFileHash, resolveRepoPath } from './lib/git.js';
import { getRepoRoot } from './lib/repo-root.js';
import { extractIdentifiers } from './lib/tokenizer.js';
import { extractDefinitions, extractReferences } from './lib/symbols.js';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

const rawPath = process.argv[2];
if (!rawPath) process.exit(0);

// Normalise to a repo-relative path — that is the key the index uses. Making
// it relative to the CWD instead produced a different key for the same file
// whenever the session started in a subdirectory, so edits were written as
// duplicate chunks and the unchanged-file hash check never matched.
const filePath = path.relative(getRepoRoot(), path.resolve(rawPath));

const config = loadConfig();

// Skip if file doesn't match indexing patterns
if (!shouldIndex(filePath, config)) process.exit(0);

// Skip if DB doesn't exist yet (sync.js hasn't run)
const dbPath = path.join(config.storage.path, 'embeddings.db');
if (!existsSync(dbPath)) process.exit(0);

// Safe DB init
let db;
try {
  db = openDatabase(dbPath, config.embedding.dimensions);
} catch (err) {
  console.error(`Beacon: embed-file failed to open database: ${err.message}`);
  process.exit(0);
}

const embedder = new Embedder(config);

try {
  // Wrap in async IIFE to allow early returns (which properly trigger finally block)
  await (async () => {
    const content = readFileSync(resolveRepoPath(filePath), 'utf-8');
    const fileHash = getFileHash(filePath);

    // Skip if file hasn't actually changed
    const indexedHash = db.getFileHash(filePath);
    if (fileHash === indexedHash) return; // early exit — file unchanged

    const chunks = chunkCode(content, filePath, config);
    if (chunks.length === 0) return; // early exit — no chunks

    const definitions = extractDefinitions(content, filePath);
    db.replaceFileSymbols(filePath, definitions, extractReferences(content, filePath, definitions.map(d => d.name)));

    const texts = chunks.map(c => c.text);
    const embeddings = await embedder.embedDocuments(texts);

    for (let i = 0; i < chunks.length; i++) {
      const identifiers = extractIdentifiers(chunks[i].text);
      db.upsertChunk(filePath, chunks[i].index, chunks[i].text, chunks[i].startLine, chunks[i].endLine, embeddings[i], fileHash, identifiers);
    }

    db.deleteOrphanChunks(filePath, chunks.length - 1);
  })();
} catch (err) {
  // Fail silently — don't block the user
  console.error(`Beacon: embed failed for ${filePath}: ${err.message}`);
} finally {
  db?.close();
}
