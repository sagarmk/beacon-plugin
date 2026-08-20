// Builds a throwaway git repo with a Beacon config pointed at a stub embedder,
// and runs the real scripts against it as subprocesses.
//
// These scripts are entry points, not modules — they read config, open the DB
// and act at import time. Driving them any other way would test something other
// than what actually runs.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { execFileSync, spawn } from 'child_process';
import Database from 'better-sqlite3';

const PLUGIN_ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPTS = join(PLUGIN_ROOT, 'scripts');

export function createRepo({ apiBase, dims, files, config = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'beacon-it-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });

  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Beacon Test');

  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'beacon.json'), JSON.stringify({
    embedding: { api_base: apiBase, model: 'stub', dimensions: dims, batch_size: 8, query_prefix: '', document_prefix: '' },
    indexing: { auto_index: true, concurrency: 2 },
    storage: { path: '.claude/.beacon' },
    ...config,
  }, null, 2));

  git('add', '-A');
  git('commit', '-qm', 'init');

  return {
    root,
    dbPath: join(root, '.claude', '.beacon', 'embeddings.db'),

    write(rel, content) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    remove(rel) { unlinkSync(join(root, rel)); },
    commit(msg = 'change') { git('add', '-A'); git('commit', '-qm', msg); },

    /**
     * Run a Beacon script, optionally from a subdirectory of the repo.
     *
     * Async on purpose. spawnSync blocks this process's event loop, which means
     * the stub embedder — an HTTP server running right here — cannot accept the
     * child's connection, and every index times out having served zero requests.
     */
    run(script, args = [], { cwd = root } = {}) {
      return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [join(SCRIPTS, script), ...args], {
          cwd, env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
        child.on('error', (err) => { clearTimeout(timer); reject(err); });
        child.on('close', (status) => {
          clearTimeout(timer);
          resolveRun({ stdout, stderr, status, all: stdout + stderr });
        });
      });
    },

    /** Query the index directly — assertions should look at stored state. */
    db() {
      if (!existsSync(this.dbPath)) return null;
      return new Database(this.dbPath, { readonly: true });
    },
    query(sql, ...params) {
      const d = this.db();
      if (!d) return [];
      try { return d.prepare(sql).all(...params); } finally { d.close(); }
    },
    one(sql, ...params) {
      const rows = this.query(sql, ...params);
      return rows.length ? Object.values(rows[0])[0] : null;
    },
    indexedFiles() {
      return this.query('SELECT DISTINCT file_path FROM chunks ORDER BY file_path').map(r => r.file_path);
    },
    syncState(key) {
      const rows = this.query('SELECT value FROM sync_state WHERE key = ?', key);
      return rows.length ? rows[0].value : null;
    },
    /** Rewrite sync_state directly — used to stage a half-finished index. */
    setSyncState(mutate) {
      const d = new Database(this.dbPath);
      try { mutate(d); } finally { d.close(); }
    },

    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export const jsFile = (name, extra = '') => `// Module ${name} handles ${name} processing.
export function process_${name}(input) {
  return input.map((x) => x);
}
export function validate_${name}(record) {
  if (!record) throw new Error('${name} missing');
  return true;
}
${extra}`;
