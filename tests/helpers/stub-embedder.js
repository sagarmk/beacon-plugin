// A real HTTP server speaking the OpenAI embeddings API, returning vectors
// derived deterministically from the input text.
//
// The scripts under test run as subprocesses, so module mocking cannot reach
// them — and mocking would skip the HTTP path, which is where batching, retry
// and the query/document split actually live. A stub server keeps that path
// real while removing the Ollama dependency, so these tests run anywhere.

import { createServer } from 'http';

// FNV-1a: small, dependency-free, and stable across runs — the same text must
// always produce the same vector or similarity assertions become flaky.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Deterministic unit vector. Texts sharing a prefix land near each other, which
// lets a test assert "this chunk is more similar than that one" meaningfully.
export function embedText(text, dims) {
  let seed = hash(text);
  const v = new Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const x = (seed / 0xffffffff) - 0.5;
    v[i] = x;
    norm += x * x;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] /= norm;
  return v;
}

/**
 * @param {{dims?: number, failFirst?: number, status?: number}} [opts]
 *   failFirst — reject this many requests before succeeding, for retry paths.
 *   status    — respond with this HTTP status instead of embedding.
 */
export async function startStubEmbedder(opts = {}) {
  const dims = opts.dims ?? 64;
  let remainingFailures = opts.failFirst ?? 0;
  const calls = [];

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* record the raw call anyway */ }
      calls.push({ url: req.url, body: parsed });

      if (opts.status) {
        res.writeHead(opts.status, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      }
      if (remainingFailures > 0) {
        remainingFailures--;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stub transient failure' } }));
      }

      const input = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
      const out = input.map((t, i) => ({
        object: 'embedding',
        index: i,
        embedding: embedText(String(t), parsed.dimensions || dims),
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: out, model: parsed.model || 'stub' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    apiBase: `http://127.0.0.1:${port}/v1`,
    dims,
    calls,
    callCount: () => calls.length,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
