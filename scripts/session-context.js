#!/usr/bin/env node
// Called by: SessionStart hook
// Purpose: tell the model the search tools exist, before it decides how to search.
//
// The Grep hook can only correct a choice already made, and only when it
// recognises the move: exploring with `cat` offers nothing to intercept, a
// single-file grep is legitimately allowed, and a direct question about the
// index issues no search at all. Measured, that left three of five tools
// unreachable and made every adoption cost a denied tool call first.
//
// Announcing the tools up front is cheap and proactive. Stays silent unless the
// index can actually serve a query — advertising tools that then error is worse
// than saying nothing.

import { existsSync } from 'fs';
import path from 'path';

// Never let a context hook break a session; any failure just prints nothing.
try {
  const { loadConfig } = await import('./lib/config.js');
  const config = loadConfig();

  const dbPath = path.join(config.storage.path, 'embeddings.db');
  if (!existsSync(dbPath)) process.exit(0);

  const { BeaconDatabase } = await import('./lib/db.js');
  const health = BeaconDatabase.healthCheck(dbPath, config.embedding.dimensions);
  if (!health.ok || health.fileCount === 0) process.exit(0);

  // Symbol tools only work once the graph is populated, so only mention them
  // when they will answer. An older index still gets the search line.
  let hasGraph = false;
  try {
    const { openDatabase } = await import('./lib/open-db.js');
    const db = openDatabase(dbPath, config.embedding.dimensions);
    hasGraph = db.hasSymbolGraph();
    db.close();
  } catch { /* fall back to search-only guidance */ }

  const lines = [
    `This repo has a Beacon code index (${health.fileCount} files, ${health.chunkCount} chunks). Prefer its MCP tools over grep/cat for code search:`,
  ];
  if (hasGraph) {
    lines.push(
      `- find_symbol(name) — where a symbol is defined. Exact and instant; use it instead of grepping for a definition.`,
      `- find_references(name) — every call site. Exhaustive, so it is the only correct tool for "what breaks if I change this".`,
      `- outline(file) — a file's symbols with line numbers. Use before reading a file to find the part that matters.`,
    );
  }
  lines.push(
    `- search_code(query) — find code by description when you cannot name it. Use it instead of reading files one by one.`,
    `- index_status() — index health, when results look stale or empty.`,
    `Grep still wins for literal text, regex, case-sensitive matches, and anything outside the index (node_modules, dist, lockfiles, .env).`,
  );

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n'),
    },
  }));
} catch {
  process.exit(0);
}
