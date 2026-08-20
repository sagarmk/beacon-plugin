// Hybrid search utilities — identifier extraction, FTS query prep, scoring

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am',
  'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'they', 'them', 'their'
]);

// Splits camelCase and PascalCase into parts: "signInWithGoogle" → ["sign", "In", "With", "Google"]
function splitCamelCase(word) {
  return word.replace(/([a-z])([A-Z])/g, '$1 $2')
             .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
             .split(/\s+/);
}

/**
 * Extract code identifiers from chunk text, splitting camelCase/snake_case for FTS indexing.
 * "signInWithGoogle" → "signInWithGoogle sign In With Google"
 */
export function extractIdentifiers(text) {
  // Match camelCase, PascalCase, snake_case identifiers (at least 2 chars)
  const identifierPattern = /[a-zA-Z_$][a-zA-Z0-9_$]{1,}/g;
  const seen = new Set();
  const parts = [];

  for (const match of text.matchAll(identifierPattern)) {
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);

    // Skip if it's a stop word or all-lowercase short word (likely prose)
    if (STOP_WORDS.has(id.toLowerCase()) && id.length < 6) continue;

    const isCamel = /[a-z][A-Z]/.test(id);
    const isSnake = id.includes('_');

    if (isCamel || isSnake) {
      parts.push(id); // keep original
      if (isCamel) {
        parts.push(...splitCamelCase(id));
      }
      if (isSnake) {
        parts.push(...id.split('_').filter(Boolean));
      }
    }
  }

  return parts.join(' ');
}

/**
 * Common programming abbreviation synonyms for query expansion.
 */
const SYNONYMS = new Map([
  ['auth', ['authentication', 'authorize', 'authorization', 'login']],
  ['config', ['configuration', 'settings', 'preferences']],
  ['db', ['database', 'sqlite', 'postgres', 'mysql']],
  ['err', ['error', 'exception']],
  ['fn', ['function', 'method']],
  ['func', ['function', 'method']],
  ['init', ['initialize', 'initialization', 'setup']],
  ['msg', ['message']],
  ['nav', ['navigation', 'navigate', 'router']],
  ['param', ['parameter', 'argument']],
  ['pkg', ['package']],
  ['req', ['request']],
  ['res', ['response']],
  ['repo', ['repository']],
  ['sync', ['synchronize', 'synchronization']],
  ['util', ['utility', 'utilities', 'helper']],
  ['utils', ['utility', 'utilities', 'helper']],
  ['env', ['environment']],
  ['middleware', ['interceptor', 'handler']],
  ['api', ['endpoint', 'route']],
]);

/**
 * Expand a token with synonyms from the SYNONYMS map.
 */
function expandWithSynonyms(token) {
  const lower = token.toLowerCase();
  const syns = SYNONYMS.get(lower);
  return syns ? syns.map(s => `"${s}"`) : [];
}

/**
 * Convert a user query into an FTS5 MATCH expression.
 * Uses tiered strategy: AND-first for 3+ tokens, OR fallback.
 * Strips stop words, quotes tokens, expands synonyms.
 * Returns null if the query is purely semantic (all stop words).
 */
export function prepareFTSQuery(query) {
  const tokens = query
    .replace(/[^\w\s]/g, ' ')  // strip punctuation
    .split(/\s+/)
    .filter(t => t.length > 0)
    .filter(t => !STOP_WORDS.has(t.toLowerCase()));

  if (tokens.length === 0) return null;

  // Also split camelCase/snake_case tokens from the query
  const expanded = [];
  for (const token of tokens) {
    expanded.push(`"${token}"`);
    const isCamel = /[a-z][A-Z]/.test(token);
    const isSnake = token.includes('_');
    if (isCamel) {
      for (const part of splitCamelCase(token)) {
        if (part.length > 1 && !STOP_WORDS.has(part.toLowerCase())) {
          expanded.push(`"${part}"`);
        }
      }
    }
    if (isSnake) {
      for (const part of token.split('_')) {
        if (part.length > 1 && !STOP_WORDS.has(part.toLowerCase())) {
          expanded.push(`"${part}"`);
        }
      }
    }
    // Query expansion: add synonyms
    expanded.push(...expandWithSynonyms(token));
  }

  // Deduplicate
  const unique = [...new Set(expanded)];

  // Tiered strategy: 3+ tokens → AND-first (returns {andQuery, orQuery})
  // Caller can try AND first, fall back to OR if no results
  if (tokens.length >= 3) {
    // AND query uses only the original tokens (not expanded synonyms)
    const andTokens = [...new Set(tokens.map(t => `"${t}"`))];
    return {
      andQuery: andTokens.join(' AND '),
      orQuery: unique.join(' OR '),
    };
  }

  return unique.join(' OR ');
}

/**
 * Min-max normalize BM25 scores (which are negative — more negative = better match) to [0, 1].
 */
export function normalizeBM25(scores) {
  if (scores.length === 0) return [];
  // A lone candidate receives the full BM25 weight regardless of how weak its
  // raw score is. That looks wrong, and an absolute scale — 1 - e^(rank/k),
  // scoring each candidate on its own merit — is the obvious correction.
  // Measured, it is worse: 0.667 to 0.736 MRR against 0.792 for min-max across
  // k = 2..20 on a 12-query benchmark, only matching min-max at k = 20 where
  // the curve is flat enough to barely contribute. The positional stretch is
  // apparently doing useful work, so this stays as it is. Do not "fix" it
  // without re-running that sweep.
  if (scores.length === 1) return [1.0];

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  if (min === max) return scores.map(() => 1.0);

  // BM25 scores from FTS5 are negative: -20 is better than -1
  // min (most negative) = best match → 1.0, max (least negative) = worst → 0.0
  return scores.map(s => (max - s) / (max - min));
}


/**
 * Reciprocal Rank Fusion scoring.
 */
export function rrfScore(vecRank, ftsRank, k = 60) {
  let score = 0;
  if (vecRank !== null && vecRank !== undefined) score += 1 / (k + vecRank);
  if (ftsRank !== null && ftsRank !== undefined) score += 1 / (k + ftsRank);
  return score;
}

/**
 * Returns a score multiplier based on file type.
 * README.md → 0.5, other .md → 0.7, test files → 0.85, config → 0.8, source code → 1.0
 */
export function getFileTypeMultiplier(filePath) {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop();

  if (base === 'readme.md') return 0.5;
  if (lower.endsWith('.md')) return 0.7;
  if (/\.(test|spec)\.[^.]+$/.test(lower) || /__(tests|test)__/.test(lower) || lower.includes('/test/')) return 0.85;
  if (/\.(json|ya?ml|toml|ini|cfg|conf)$/.test(lower) || base.startsWith('.')) return 0.8;
  return 1.0;
}

/**
 * Detects camelCase/snake_case identifiers in the query and returns a boost
 * multiplier if any are found as exact matches in the chunk text.
 * 1.5x boost per match, capped at 2.5x.
 */
export function getIdentifierBoost(query, chunkText) {
  const identifierPattern = /[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g;
  const queryIds = [];

  for (const match of query.matchAll(identifierPattern)) {
    const id = match[0];
    if (/[a-z][A-Z]/.test(id) || id.includes('_')) {
      queryIds.push(id);
    }
  }

  if (queryIds.length === 0) return 1.0;

  let boost = 1.0;
  for (const id of queryIds) {
    if (chunkText.includes(id)) {
      boost += 0.5; // 1.5x for first match, 2.0x for second, etc.
    }
  }

  return Math.min(boost, 2.5);
}
