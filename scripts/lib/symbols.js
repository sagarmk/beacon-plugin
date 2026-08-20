// Symbol extraction for the reference graph.
//
// Embeddings describe what code *says*; they are blind to what it *connects to*.
// A function with no doc comment has almost no natural-language surface, so a
// question phrased in English cannot reach it — but the file that calls it is
// usually retrievable, and one reference edge away. Recording definitions and
// references lets the ranker walk that edge.
//
// This is deliberately regex-based rather than tree-sitter: the chunker already
// detects declarations the same way, and a native parser per language would be
// a heavy dependency for a plugin that installs itself on first session. The
// cost is recall on unusual syntax, which is acceptable for a ranking signal —
// a missed edge weakens a boost, it never produces a wrong answer.

// Each pattern must expose the symbol name as capture group 1.
const DEFINITIONS = {
  js: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
    [/^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/, 'function'],
    [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
    [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, 'type'],
    [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
    // class method shorthand: two-space indent, name(args) {  — excluding keywords
    [/^\s{2,}(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/, 'method'],
  ],
  py: [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*class\s+([A-Za-z_][\w]*)/, 'class'],
  ],
  go: [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, 'function'],
    [/^\s*type\s+([A-Za-z_][\w]*)/, 'type'],
  ],
  rs: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][\w]*)/, 'struct'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_][\w]*)/, 'enum'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][\w]*)/, 'trait'],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[A-Za-z_][\w:]*\s+for\s+)?([A-Za-z_][\w]*)/, 'impl'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)/, 'module'],
  ],
  java: [
    [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_][\w]*)/, 'interface'],
    [/^\s*(?:public|private|protected)?\s*enum\s+([A-Za-z_][\w]*)/, 'enum'],
    [/^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\].]+\s+([A-Za-z_][\w]*)\s*\(/, 'method'],
  ],
  rb: [
    [/^\s*def\s+(?:self\.)?([A-Za-z_][\w]*[?!=]?)/, 'function'],
    [/^\s*class\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*module\s+([A-Za-z_][\w]*)/, 'module'],
  ],
  php: [
    [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_][\w]*)/, 'function'],
    [/^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/, 'class'],
    [/^\s*interface\s+([A-Za-z_][\w]*)/, 'interface'],
    [/^\s*trait\s+([A-Za-z_][\w]*)/, 'trait'],
  ],
  c: [
    [/^\s*(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s*]*\s+\*?([A-Za-z_][\w]*)\s*\([^;]*\)\s*\{/, 'function'],
    [/^\s*(?:typedef\s+)?struct\s+([A-Za-z_][\w]*)/, 'struct'],
    [/^\s*(?:typedef\s+)?enum\s+([A-Za-z_][\w]*)/, 'enum'],
    [/^\s*class\s+([A-Za-z_][\w]*)/, 'class'],
  ],
  sql: [
    [/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"\[]?([A-Za-z_][\w]*)/i, 'table'],
  ],
};

const EXT_LANG = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java', '.scala': 'java',
  '.rb': 'rb',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c', '.cxx': 'c', '.m': 'c', '.mm': 'c',
  '.sql': 'sql',
};

export function languageOf(filePath) {
  const m = String(filePath).toLowerCase().match(/(\.[a-z]+)$/);
  return m ? EXT_LANG[m[1]] || null : null;
}

// Words that look like calls but are language syntax, not references worth
// graphing. Kept small on purpose — an over-aggressive list loses real edges.
const NOT_A_REFERENCE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'const',
  'let', 'var', 'new', 'this', 'super', 'typeof', 'instanceof', 'await', 'async',
  'import', 'export', 'from', 'default', 'try', 'finally', 'throw', 'else', 'case',
  'break', 'continue', 'do', 'in', 'of', 'and', 'or', 'not', 'is', 'None', 'True',
  'False', 'null', 'true', 'false', 'undefined', 'self', 'def', 'elif', 'lambda',
  'pass', 'raise', 'with', 'as', 'print', 'len', 'str', 'int', 'float', 'bool',
  'list', 'dict', 'set', 'type', 'public', 'private', 'protected', 'static',
  'void', 'int32', 'string', 'error', 'nil', 'func', 'struct', 'enum', 'impl',
  'trait', 'mod', 'pub', 'fn', 'use', 'match', 'where', 'interface', 'extends',
  'implements', 'package', 'module', 'require', 'console', 'log',
]);

// Strip line comments and string literals so that prose and message text do not
// masquerade as code references.
function stripNoise(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
    .replace(/^\s*#.*$/gm, ' ')
    .replace(/"""[\s\S]*?"""/g, ' ')
    .replace(/'''[\s\S]*?'''/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, ' ')
    .replace(/'(?:[^'\\]|\\.)*'/g, ' ');
}

/**
 * Definitions declared in a block of source.
 * @returns {{name: string, kind: string, line: number}[]} line is 1-based within `text`
 */
export function extractDefinitions(text, filePath) {
  const lang = languageOf(filePath);
  if (!lang) return [];
  const patterns = DEFINITIONS[lang];
  if (!patterns) return [];

  const out = [];
  const seen = new Set();
  const lines = String(text).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    for (const [re, kind] of patterns) {
      const m = line.match(re);
      if (!m || !m[1]) continue;
      const name = m[1];
      if (NOT_A_REFERENCE.has(name) || name.length < 2) continue;
      const key = name + ':' + kind;
      if (seen.has(key)) break;
      seen.add(key);
      out.push({ name, kind, line: i + 1 });
      break; // one definition per line
    }
  }
  return out;
}

/**
 * Identifiers this source *uses* — candidate edges to wherever they are defined.
 * Own definitions are excluded so a file never links to itself.
 */
export function extractReferences(text, filePath, definedNames = []) {
  const own = new Set(definedNames);
  const cleaned = stripNoise(text);
  const refs = new Set();

  // Called or constructed: name( — the strongest signal of a real reference.
  for (const m of cleaned.matchAll(/([A-Za-z_$][\w$]{2,})\s*\(/g)) {
    const n = m[1];
    if (!own.has(n) && !NOT_A_REFERENCE.has(n)) refs.add(n);
  }
  // Member access on a namespace: obj.method(
  for (const m of cleaned.matchAll(/\.([A-Za-z_$][\w$]{2,})\s*\(/g)) {
    const n = m[1];
    if (!own.has(n) && !NOT_A_REFERENCE.has(n)) refs.add(n);
  }
  // Imported names — an explicit dependency even when never called directly.
  for (const m of cleaned.matchAll(/(?:import|from)\s+\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n && !own.has(n) && !NOT_A_REFERENCE.has(n) && n.length > 2) refs.add(n);
    }
  }
  // Type positions: `: TypeName` and `new TypeName`
  for (const m of cleaned.matchAll(/\bnew\s+([A-Z][\w$]{2,})/g)) {
    const n = m[1];
    if (!own.has(n)) refs.add(n);
  }
  return [...refs];
}
