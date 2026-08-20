#!/usr/bin/env node
// PreToolUse hook for Grep.
//
// This used to DENY grep and redirect to a bash command, because it was the only
// way to get Beacon results in front of the model. That inference was always
// unsound: intent is not in the pattern string. `handleAuth` looks identical
// whether the caller wants the definition, every call site, or code that merely
// resembles it — three different answers, one indistinguishable input.
//
// Beacon now exposes MCP tools the model selects itself, so the redirect names
// the specific tool that fits rather than a shell command.
//
// The default stays "redirect" (deny) because advisory mode was measured and
// does nothing: a PreToolUse hook returning additionalContext without a
// permissionDecision left tool choice completely unchanged — the model ran grep
// and never touched a Beacon tool. Denying is what actually surfaces them.
// "advise" and "off" remain available via intercept.mode.

import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');

let input;
try {
  input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));
} catch {
  process.exit(0);
}

const toolInput = input.tool_input || {};
const toolName = input.tool_name || '';

// The hook used to watch the Grep tool alone. Measured against a real session,
// the model reaches for `Bash: grep -rn ...` instead — which matched nothing
// here, so the intercept never fired at all for the most common case. Cover
// shell search commands too, and recover the pattern from the command line.
let pattern = toolInput.pattern || '';
let searchPath = toolInput.path || '';
let outputMode = toolInput.output_mode || 'files_with_matches';

if (toolName === 'Bash') {
  const cmd = String(toolInput.command || '');
  // Only a command that STARTS a pipeline. `ls | grep foo` and
  // `npm test | grep passed` filter another command's output — they are not
  // codebase searches, and advising on them is pure noise.
  const m = cmd.match(/^\s*(?:rg|grep|ag|ack)\s+([^|;&]*)/);
  if (!m) process.exit(0);
  const argv = m[1];
  if (/(?:^|\s)-[a-zA-Z]*[cl](?:\s|$)/.test(argv)) process.exit(0);  // -c/-l: counting or listing
  // First non-flag token is the pattern; strip one layer of quoting.
  const tokens = argv.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const positional = tokens.filter(t => !t.startsWith('-')).map(t => t.replace(/^["']|["']$/g, ''));
  if (positional.length === 0) process.exit(0);
  pattern = positional[0];
  searchPath = positional[1] || '';   // grep PATTERN [PATH]
  outputMode = 'content';   // shell grep prints lines
}

// --- Load config (for intercept settings + DB path) ---
let config;
try {
  const { loadConfig } = await import('./lib/config.js');
  config = loadConfig();
} catch {
  // Can't load config — allow grep through
  process.exit(0);
}

// Check if intercept is disabled via config
if (config.intercept?.enabled === false) process.exit(0);

const mode = config.intercept?.mode ?? 'redirect';
if (mode === 'off') process.exit(0);

const minLen = config.intercept?.min_pattern_length ?? 4;

// --- Allow grep through (no intercept) for legitimate grep use cases ---

// 1. Very short pattern
if (pattern.length < minLen) process.exit(0);

// 2. Regex metacharacters (not just dots or escaped chars)
if (/[*+?\[\]{}()|\\^$]/.test(pattern.replace(/\\\./g, ''))) process.exit(0);

// 3. Targeting a specific file (not a directory)
if (searchPath && !searchPath.endsWith('/') && path.extname(searchPath)) {
  process.exit(0);
}

// 4. Count mode — grep is the right tool
if (outputMode === 'count') process.exit(0);

// 5. Dotted identifier (e.g. fs.readFileSync, path.join)
if (/\w\.\w/.test(pattern)) process.exit(0);

// 6. Path-like pattern (contains / or \)
if (/[/\\]/.test(pattern)) process.exit(0);

// 7. Content output mode — the Grep tool caller wants matching lines, not file
// rankings. Shell grep always prints lines, so this rule cannot apply there.
if (toolName !== 'Bash' && outputMode === 'content') process.exit(0);

// 8. Quoted string literals (looking for exact strings in source)
if (/^["']|["']$/.test(pattern)) process.exit(0);

// 9. Annotations/markers (TODO, FIXME, @param, etc.)
if (/^[@#]|TODO|FIXME|HACK|XXX|DEPRECATED/.test(pattern)) process.exit(0);

// 10. URL-like patterns
if (/:\/{2}|localhost/.test(pattern)) process.exit(0);

// --- Scope gate: never block a search Beacon could not answer anyway ---
// The index covers specific extensions and skips node_modules, dist, lockfiles
// and the like. Redirecting a grep aimed at content outside that scope does not
// send the model somewhere better — it sends it somewhere empty, and costs it
// the one tool that would have worked.
if (searchPath) {
  const target = searchPath.replace(/^\.\//, '').replace(/\/+$/, '');
  const inc = config.indexing?.include || [];
  const exc = config.indexing?.exclude || [];
  try {
    const picomatch = (await import('picomatch')).default;
    const firstSegment = target.split('/')[0];
    const excluded = exc.some(p =>
      picomatch.isMatch(target, p) ||
      picomatch.isMatch(target + '/x', p) ||
      picomatch.isMatch(firstSegment + '/x', p));
    if (excluded) process.exit(0);
    // A concrete file must match an include pattern to be in the index at all.
    if (/\.[A-Za-z0-9]+$/.test(target) && !inc.some(p => picomatch.isMatch(target, p))) {
      process.exit(0);
    }
  } catch {
    // picomatch unavailable — fall through rather than block on a scope check
  }
}

// --- Health gate: only intercept if Beacon index is healthy ---
try {
  const { BeaconDatabase } = await import('./lib/db.js');
  const dbPath = path.join(config.storage.path, 'embeddings.db');

  if (!existsSync(dbPath)) process.exit(0);
  const dbStat = statSync(dbPath);
  if (dbStat.size < 4096) process.exit(0);

  const health = BeaconDatabase.healthCheck(dbPath, config.embedding.dimensions);
  if (!health.ok) process.exit(0);
} catch {
  // Any error in health check — allow grep through
  process.exit(0);
}

// --- Point at the tool that fits, by what the pattern looks like ---
// A single identifier is almost always a "where is this" question; multi-word
// prose is a concept search. Both are stated as suggestions, not conclusions.
const isSingleIdentifier = /^[A-Za-z_$][\w$]*$/.test(pattern);
const suggestion = isSingleIdentifier
  ? `Beacon MCP tools are available and are exact for this: find_symbol("${pattern}") returns where it is ` +
    `defined, and find_references("${pattern}") returns every call site — both without ranking or truncation. ` +
    `Keep grep if you need literal text matches, including inside strings and comments.`
  : `Beacon MCP tools are available: search_code searches this repo by meaning, which suits a multi-word ` +
    `description better than literal matching. Keep grep if you need exact text.`;

if (mode === 'redirect') {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      additionalContext: suggestion,
    },
  }));
  process.exit(0);
}

// Default: let grep run, and mention the alternative.
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    additionalContext: suggestion,
  },
}));
