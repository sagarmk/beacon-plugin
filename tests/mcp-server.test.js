import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

const SERVER = resolve(import.meta.dirname, '..', 'scripts', 'mcp-server.js');

// Driven over real stdio with real JSON-RPC frames rather than by importing the
// handler: framing, notification suppression and stdout hygiene are exactly the
// parts that break, and an in-process call would exercise none of them.
function startServer(cwd) {
  const proc = spawn('node', [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const stdoutLines = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      stdoutLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolver = pending.get(msg.id);
      if (resolver) { pending.delete(msg.id); resolver(msg); }
    }
  });
  proc.stderr.resume(); // diagnostics belong here; drain so the pipe never fills

  let id = 0;
  return {
    proc,
    stdoutLines,
    request(method, params) {
      const myId = ++id;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout: ${method}`)), 20000);
        pending.set(myId, (m) => { clearTimeout(timer); res(m); });
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
      });
    },
    notify(method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    raw(text) { proc.stdin.write(text + '\n'); },
    stop() { try { proc.stdin.end(); proc.kill(); } catch { /* already gone */ } },
  };
}

describe('beacon MCP server', () => {
  let srv, tmp;

  beforeAll(() => {
    // A directory with no index, so tool calls exercise the failure path.
    tmp = mkdtempSync(join(tmpdir(), 'beacon-mcp-'));
    srv = startServer(tmp);
  });

  afterAll(() => {
    srv?.stop();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  describe('handshake', () => {
    it('responds to initialize with capabilities and server info', async () => {
      const r = await srv.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      expect(r.result.serverInfo.name).toBe('beacon');
      expect(r.result.capabilities).toHaveProperty('tools');
      expect(r.result.protocolVersion).toBe('2025-06-18');
    });

    it('falls back to a supported version when the client asks for an unknown one', async () => {
      const r = await srv.request('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
      expect(r.result.protocolVersion).not.toBe('1999-01-01');
      expect(typeof r.result.protocolVersion).toBe('string');
    });

    it('does not reply to notifications', async () => {
      const before = srv.stdoutLines.length;
      srv.notify('notifications/initialized');
      // Any reply would arrive well within this; a round-trip proves the queue drained.
      await srv.request('ping', {});
      const emitted = srv.stdoutLines.slice(before);
      // exactly one frame — the ping reply, nothing for the notification
      expect(emitted).toHaveLength(1);
    });
  });

  describe('tools/list', () => {
    it('advertises every tool with a valid input schema', async () => {
      const r = await srv.request('tools/list', {});
      const names = r.result.tools.map((t) => t.name).sort();
      expect(names).toEqual(['find_references', 'find_symbol', 'index_status', 'outline', 'search_code']);
      for (const t of r.result.tools) {
        expect(t.description.length).toBeGreaterThan(20);
        expect(t.inputSchema.type).toBe('object');
      }
    });

    it('marks required arguments', async () => {
      const r = await srv.request('tools/list', {});
      const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
      expect(byName.search_code.inputSchema.required).toContain('query');
      expect(byName.find_symbol.inputSchema.required).toContain('name');
      expect(byName.outline.inputSchema.required).toContain('file');
      expect(byName.index_status.inputSchema.required ?? []).toEqual([]);
    });
  });

  describe('errors', () => {
    it('returns method-not-found for an unknown method', async () => {
      const r = await srv.request('does/not/exist', {});
      expect(r.error.code).toBe(-32601);
    });

    it('returns invalid-params for an unknown tool', async () => {
      const r = await srv.request('tools/call', { name: 'nope', arguments: {} });
      expect(r.error.code).toBe(-32602);
    });

    it('survives a malformed frame and keeps serving', async () => {
      srv.raw('{ this is not json');
      const r = await srv.request('tools/list', {});
      expect(r.result.tools.length).toBeGreaterThan(0);
    });

    it('reports a missing index as a tool result, not a protocol error', async () => {
      // A protocol error would look like a broken server; the model needs to
      // read the reason and act on it instead.
      const r = await srv.request('tools/call', { name: 'index_status', arguments: {} });
      expect(r.error).toBeUndefined();
      expect(r.result.isError).toBe(true);
      const payload = JSON.parse(r.result.content[0].text);
      expect(payload.error).toMatch(/index/i);
    });

    it('rejects a search with no query', async () => {
      const r = await srv.request('tools/call', { name: 'search_code', arguments: {} });
      const payload = JSON.parse(r.result.content[0].text);
      expect(payload.error).toBeTruthy();
    });
  });

  describe('stdout hygiene', () => {
    it('emits only valid JSON-RPC frames', () => {
      // A stray console.log anywhere in the server corrupts the stream and takes
      // down the whole connection, so assert every line parses.
      expect(srv.stdoutLines.length).toBeGreaterThan(0);
      for (const line of srv.stdoutLines) {
        const parsed = JSON.parse(line);
        expect(parsed.jsonrpc).toBe('2.0');
      }
    });
  });
});
