#!/usr/bin/env node
// Beacon MCP server — exposes search as tools Claude picks itself.
//
// The Grep hook has to infer intent from the shape of a pattern string, and
// intent is not in there: `handleAuth` looks identical whether the caller wants
// the definition, every call site, or code that merely resembles it. Three
// different answers, one indistinguishable input. As tools, the caller states
// which it wants.
//
// Three of the four search tools never embed anything — they are indexed SQL
// lookups over the symbol tables, ~0.01ms against ~200ms for a semantic search.
//
// Protocol is newline-delimited JSON-RPC 2.0 on stdio, hand-rolled: the official
// SDK pulls express, hono, jose and cors (4.3MB, 17 deps) to serve HTTP
// transports this never uses, and Beacon installs its own dependencies inside a
// 180s session hook that native better-sqlite3 already dominates.
//
// STDOUT CARRIES PROTOCOL ONLY. Every diagnostic goes to stderr; a stray
// console.log here corrupts the stream and takes the whole server down.

import { existsSync, statSync } from 'fs';
import path from 'path';

// Claude Code may launch the server from anywhere. Config discovery and every
// repo-relative path resolve from the working directory, so anchor it first.
if (process.env.CLAUDE_PROJECT_DIR && existsSync(process.env.CLAUDE_PROJECT_DIR)) {
  try { process.chdir(process.env.CLAUDE_PROJECT_DIR); } catch { /* keep cwd */ }
}

const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'beacon', version: '1.0.0' };

const log = (...a) => console.error('[beacon-mcp]', ...a);

// ── lazy, self-invalidating database handle ──────────────────────────────────
// Long-lived process, and /reindex replaces the file underneath us. Reopen when
// the file changes rather than serving results from a stale handle.
let _db = null, _dbKey = '', _config = null;

async function getConfig() {
  if (_config) return _config;
  const { loadConfig } = await import('./lib/config.js');
  _config = loadConfig();
  return _config;
}

async function getDb() {
  const config = await getConfig();
  const dbPath = path.join(config.storage.path, 'embeddings.db');
  if (!existsSync(dbPath)) {
    const err = new Error('No Beacon index for this project yet. Run /index (or `node scripts/sync.js`) first.');
    err.userFacing = true;
    throw err;
  }
  const st = statSync(dbPath);
  const key = `${st.mtimeMs}:${st.size}`;
  if (_db && _dbKey === key) return _db;
  if (_db) { try { _db.close(); } catch {} _db = null; }
  const { openDatabase } = await import('./lib/open-db.js');
  _db = openDatabase(dbPath, config.embedding.dimensions);
  _dbKey = key;
  const dim = _db.checkDimensions();
  if (!dim.ok) {
    const err = new Error(
      `Index holds ${dim.stored}-dimension embeddings but the config asks for ${dim.current}. Run /reindex.`
    );
    err.userFacing = true;
    throw err;
  }
  return _db;
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

// ── tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search_code',
    description:
      'Search code by meaning. Use for conceptual questions — "how does billing retry work", ' +
      '"where is rate limiting handled". Returns ranked snippets with file paths and line ranges. ' +
      'Do NOT use to locate a known symbol: find_symbol is exact and ~20000x faster. ' +
      'mode="lexical" skips the embedding model entirely (keyword only, fast); ' +
      'mode="semantic" uses embeddings only, no keyword signal.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language description of what the code does.' },
        top_k: { type: 'integer', description: 'Max results (default from config, usually 10).', minimum: 1, maximum: 50 },
        path: { type: 'string', description: 'Restrict to files under this repo-relative path prefix.' },
        mode: { type: 'string', enum: ['hybrid', 'semantic', 'lexical'], description: 'Default hybrid.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_symbol',
    description:
      'Find where a symbol is DEFINED, by exact name. Use for "where is handleAuth defined". ' +
      'Exact lookup, no ranking, no embedding — returns file and line. Prefer this over search_code ' +
      'and over Grep whenever you already know the name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact symbol name, case-sensitive.' } },
      required: ['name'],
    },
  },
  {
    name: 'find_references',
    description:
      'Find every file that REFERENCES a symbol — its call sites. Use for "what calls handleAuth", ' +
      'impact analysis before a change, or tracing data flow. Exhaustive over indexed files, ' +
      'not a ranked sample, so it answers questions ranked search cannot.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact symbol name, case-sensitive.' } },
      required: ['name'],
    },
  },
  {
    name: 'outline',
    description:
      'List the symbols declared in one file, in source order, with line numbers. Use to understand ' +
      'a file\'s structure before reading it — far cheaper than reading the whole file.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Repo-relative path, or a distinctive fragment of one.' } },
      required: ['file'],
    },
  },
  {
    name: 'index_status',
    description:
      'Health of the Beacon index: files and chunks indexed, embedding model, whether the symbol ' +
      'graph is populated, and whether a sync is in progress or errored. Check this when results ' +
      'look stale or empty.',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function searchCode(args) {
  const db = await getDb();
  const config = await getConfig();
  const query = String(args.query || '').trim();
  if (!query) throw Object.assign(new Error('query is required'), { userFacing: true });

  const topK = args.top_k || config.search.top_k;
  const pathPrefix = args.path || null;
  const mode = args.mode || 'hybrid';

  // Lexical needs no embedding at all, so it also serves as the fallback when
  // the embedding endpoint is unreachable.
  if (mode === 'lexical') {
    const rows = db.ftsOnlySearch(query, topK, pathPrefix);
    return { mode: 'lexical', count: rows.length, results: rows.map(formatRow) };
  }

  const cfg = JSON.parse(JSON.stringify(config));
  if (mode === 'semantic') cfg.search.hybrid.enabled = false;

  const { Embedder } = await import('./lib/embedder.js');
  let embedding;
  try {
    [embedding] = await new Embedder(cfg).embedQueries([query]);
  } catch (err) {
    const rows = db.ftsOnlySearch(query, topK, pathPrefix);
    return {
      mode: 'lexical',
      degraded: `Embedding endpoint unreachable (${err.message}); answered with keyword search only.`,
      count: rows.length,
      results: rows.map(formatRow),
    };
  }
  const rows = db.search(embedding, topK, cfg.search.similarity_threshold, query, cfg, pathPrefix);
  return { mode, count: rows.length, results: rows.map(formatRow) };
}

function formatRow(r) {
  return {
    file: r.filePath,
    lines: `${r.startLine}-${r.endLine}`,
    ...(typeof r.similarity === 'number' ? { similarity: Number(r.similarity.toFixed(3)) } : {}),
    ...(typeof r.score === 'number' ? { score: Number(r.score.toFixed(3)) } : {}),
    preview: truncate(r.chunkText || '', 400),
  };
}

async function findSymbol(args) {
  const db = await getDb();
  const name = String(args.name || '').trim();
  if (!name) throw Object.assign(new Error('name is required'), { userFacing: true });
  if (!db.hasSymbolGraph()) return staleGraphNotice();

  const hits = db.filesDefining([name]).map(r => r.file_path);
  const defs = [];
  for (const file of hits) {
    for (const s of db.symbolsInFile(file)) {
      if (s.name === name) defs.push({ file, kind: s.kind, line: s.line });
    }
  }
  if (defs.length === 0) {
    return {
      found: 0,
      definitions: [],
      hint: `No indexed definition of "${name}". It may be defined in a dependency, declared dynamically, ` +
            `or the name may differ in case. Try search_code, or Grep for an exact-text match.`,
    };
  }
  return { found: defs.length, definitions: defs };
}

async function findReferences(args) {
  const db = await getDb();
  const name = String(args.name || '').trim();
  if (!name) throw Object.assign(new Error('name is required'), { userFacing: true });
  if (!db.hasSymbolGraph()) return staleGraphNotice();

  const files = db.referencesTo(name);
  const definedIn = db.filesDefining([name]).map(r => r.file_path);
  return {
    symbol: name,
    defined_in: definedIn,
    referenced_by: files,
    count: files.length,
    ...(files.length === 0
      ? { hint: `No indexed references to "${name}". References are collected from call sites, member ` +
                `access and named imports; a symbol reached only dynamically will not appear.` }
      : {}),
  };
}

async function outline(args) {
  const db = await getDb();
  const file = String(args.file || '').trim();
  if (!file) throw Object.assign(new Error('file is required'), { userFacing: true });
  if (!db.hasSymbolGraph()) return staleGraphNotice();

  let symbols = db.symbolsInFile(file);
  let resolved = file;
  if (symbols.length === 0) {
    // Accept a fragment rather than forcing the caller to know the exact path.
    const candidates = db.filesMatching(file);
    if (candidates.length === 1) {
      resolved = candidates[0];
      symbols = db.symbolsInFile(resolved);
    } else if (candidates.length > 1) {
      return { file, matches: candidates, hint: 'Path is ambiguous — call again with one of these.' };
    }
  }
  if (symbols.length === 0) {
    return { file: resolved, symbols: [], hint: 'No indexed symbols. The file may be prose, or of an unsupported language.' };
  }
  return { file: resolved, count: symbols.length, symbols };
}

async function indexStatus() {
  const config = await getConfig();
  const db = await getDb();
  const stats = db.getStats();
  const graph = db.hasSymbolGraph();
  return {
    files: stats.fileCount,
    chunks: stats.chunkCount,
    embedding_model: config.embedding.model,
    dimensions: config.embedding.dimensions,
    symbol_graph: graph ? 'populated' : 'empty (reindex to enable find_symbol / find_references / outline)',
    sync_status: db.getSyncState('sync_status') || 'idle',
    ...(db.getSyncState('sync_error') ? { sync_error: db.getSyncState('sync_error') } : {}),
    last_sync: db.getSyncState('last_sync_time') || null,
  };
}

const staleGraphNotice = () => ({
  error: 'The symbol graph is empty for this index.',
  hint: 'This index predates symbol extraction. Run /reindex to enable find_symbol, find_references and outline.',
});

const HANDLERS = {
  search_code: searchCode,
  find_symbol: findSymbol,
  find_references: findReferences,
  outline,
  index_status: indexStatus,
};

// ── JSON-RPC plumbing ────────────────────────────────────────────────────────

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    const version = SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0];
    return reply(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return isNotification ? undefined : reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const handler = HANDLERS[name];
    if (!handler) return fail(id, -32602, `Unknown tool: ${name}`);
    try {
      const result = await handler(params?.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      // Tool-level problems come back as tool results, not protocol errors, so
      // the model can read the explanation and choose differently.
      log(`${name} failed:`, err.message);
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }, null, 2) }],
        isError: true,
      });
    }
  }

  if (isNotification) return;
  return fail(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(null, -32700, 'Parse error');
      continue;
    }
    Promise.resolve(handle(msg)).catch((err) => {
      log('handler error:', err.stack || err.message);
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32603, err.message);
    });
  }
});
process.stdin.on('end', () => { try { _db?.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { _db?.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { try { _db?.close(); } catch {} process.exit(0); });

log('ready');
