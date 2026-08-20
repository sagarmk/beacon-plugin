import path from 'path';

// Regex-based boundary detection per language
// No `g` flag — we test one line at a time, so `g` would cause lastIndex bugs
const BOUNDARIES = {
  '.ts':   /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const\s+\w+\s*=\s*(?:async\s+)?\(|enum)\b/m,
  '.tsx':  /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const\s+\w+\s*=\s*(?:async\s+)?\(|enum)\b/m,
  '.js':   /^(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\()\b/m,
  '.jsx':  /^(?:export\s+)?(?:async\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\()\b/m,
  '.py':   /^(?:def |class |async def )/m,
  '.go':   /^(?:func |type )/m,
  '.rs':   /^(?:pub\s+)?(?:fn |struct |enum |impl |trait |mod )/m,
  '.java': /^(?:public |private |protected )?(?:static\s+)?(?:class |interface |enum |.*\s+\w+\s*\()/m,
  '.rb':   /^(?:def |class |module )/m,
  '.php':  /^(?:function |class |interface |trait )/m,
  '.sql':  /^(?:CREATE |ALTER |DROP |INSERT |SELECT |WITH |-- ===)/im,
};

export function chunkCode(content, filePath, config) {
  const ext = path.extname(filePath);
  const strategy = config.chunking.strategy; // "syntax", "fixed", or "hybrid"

  const maxTokens = config.chunking.max_tokens;
  const overlap = config.chunking.overlap_tokens;

  if (strategy === 'syntax' || strategy === 'hybrid') {
    const syntaxChunks = trySyntaxChunk(content, ext);
    if (syntaxChunks.length > 0) {
      // "syntax" takes the boundaries as-is. "hybrid" means what it says: a
      // declaration with no inner boundary (a 600-line class, say) would
      // otherwise become ONE chunk regardless of max_tokens, and a single
      // vector spread over hundreds of lines retrieves badly for any one
      // method in it. Re-split anything oversized with the fixed chunker.
      if (strategy !== 'hybrid') return syntaxChunks;
      const out = [];
      for (const c of syntaxChunks) {
        if (c.text.length <= maxTokens * 4) { out.push(c); continue; }
        for (const sub of fixedChunk(c.text, maxTokens, overlap)) {
          out.push({
            index: out.length,
            text: sub.text,
            // sub-chunk lines are relative to the parent chunk
            startLine: c.startLine + sub.startLine - 1,
            endLine: c.startLine + sub.endLine - 1,
          });
        }
      }
      return out.map((c, i) => ({ ...c, index: i }));
    }
    // hybrid: fall through to fixed if syntax found nothing
  }

  return fixedChunk(content, maxTokens, overlap);
}

function trySyntaxChunk(content, ext) {
  const pattern = BOUNDARIES[ext];
  if (!pattern) return [];

  const lines = content.split('\n');
  const boundaries = [];

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      boundaries.push(i);
    }
  }

  if (boundaries.length < 2) return [];

  // A declaration's doc comment is the best natural-language description of it
  // that exists. Splitting exactly ON the declaration line stranded every
  // comment block with the PRECEDING declaration, so the sentence describing
  // function B was embedded as part of function A. Walk each boundary back
  // over its own comments and decorators first.
  const starts = boundaries.map(b => claimPreamble(lines, b));

  const chunks = [];
  // Everything above the first declaration - file header, imports, constants -
  // used to be dropped on the floor and never indexed at all.
  if (starts[0] > 0) {
    const head = lines.slice(0, starts[0]);
    if (head.some(l => l.trim())) {
      chunks.push({ index: 0, text: head.join('\n'), startLine: 1, endLine: starts[0] });
    }
  }

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const end = (i + 1 < starts.length) ? starts[i + 1] - 1 : lines.length - 1;
    if (end < start) continue;
    chunks.push({
      index: chunks.length,
      text: lines.slice(start, end + 1).join('\n'),
      startLine: start + 1,
      endLine: end + 1
    });
  }

  return chunks.map((c, i) => ({ ...c, index: i }));
}

// Line comments, block comments, docstrings and decorators sitting directly
// above a declaration belong to it. A single blank line between a comment block
// and its declaration is normal formatting and is crossed; anything else stops
// the walk, and it never reaches back past the previous declaration.
const COMMENT_LINE = /^\s*(\/\/|#|\/\*|\*|--|;;|@|["']{3})/;
function claimPreamble(lines, at) {
  let i = at - 1;
  let claimed = at;
  while (i >= 0) {
    const t = lines[i].trim();
    if (!t) {
      if (i - 1 >= 0 && COMMENT_LINE.test(lines[i - 1])) { i--; continue; }
      break;
    }
    if (!COMMENT_LINE.test(lines[i])) break;
    claimed = i;
    i--;
  }
  return claimed;
}

function fixedChunk(content, maxTokens, overlapTokens) {
  // Approximate: 1 token ~ 4 chars
  const maxChars = maxTokens * 4;
  const overlapChars = overlapTokens * 4;
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentLen = 0;
  let startLine = 1;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);
    currentLen += line.length + 1;

    if (currentLen >= maxChars) {
      chunks.push({
        index: chunkIndex++,
        text: currentChunk.join('\n'),
        startLine,
        endLine: i + 1
      });

      // Overlap: keep last N chars worth of lines
      const overlapLines = [];
      let overlapLen = 0;
      for (let j = currentChunk.length - 1; j >= 0 && overlapLen < overlapChars; j--) {
        overlapLines.unshift(currentChunk[j]);
        overlapLen += currentChunk[j].length + 1;
      }
      currentChunk = overlapLines;
      currentLen = overlapLen;
      startLine = Math.max(1, i + 1 - overlapLines.length + 1);
    }
  }

  // Final chunk
  if (currentChunk.length > 0) {
    chunks.push({
      index: chunkIndex,
      text: currentChunk.join('\n'),
      startLine,
      endLine: lines.length
    });
  }

  return chunks;
}
