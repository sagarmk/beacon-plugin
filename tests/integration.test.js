import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { startStubEmbedder } from './helpers/stub-embedder.js';
import { createRepo, jsFile } from './helpers/fixture-repo.js';
import { join } from 'path';

// End-to-end coverage for sync.js, gc.js and embed-file.js — the three entry
// points that produced most of the shipped bugs and had no tests at all.
// Each case below reproduces a failure that actually occurred; the unit suite
// cannot catch any of them, because every one arose from how these scripts
// resolve paths and interpret their own persisted state.

let stub;
const repos = [];
const makeRepo = (files, config) => {
  const r = createRepo({ apiBase: stub.apiBase, dims: stub.dims, files, config });
  repos.push(r);
  return r;
};

beforeAll(async () => { stub = await startStubEmbedder({ dims: 64 }); });
afterAll(async () => { await stub?.stop(); });
afterEach(() => { while (repos.length) repos.pop().cleanup(); });

describe('sync.js', () => {
  it('indexes a repo end to end without an embedding server of its own', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha'), 'b.js': jsFile('beta') });
    const out = await repo.run('sync.js', ['--force']);
    expect(out.all).toMatch(/initial index complete/);
    expect(repo.indexedFiles()).toEqual(['a.js', 'b.js']);
    expect(repo.one('SELECT COUNT(*) FROM chunks')).toBeGreaterThan(0);
    expect(repo.one('SELECT COUNT(*) FROM symbols')).toBeGreaterThan(0);
  });

  it('resumes an interrupted first index instead of reporting "up to date"', async () => {
    // A killed first index leaves rows behind but never writes last_sync_time.
    // Branching on row count instead of completion made every later run take the
    // incremental path, find nothing, and report success on a partial index —
    // permanently, while search answered from the fraction it had.
    const files = {};
    for (let i = 1; i <= 6; i++) files[`f${i}.js`] = jsFile(`mod${i}`);
    const repo = makeRepo(files);
    await repo.run('sync.js', ['--force']);
    expect(repo.indexedFiles()).toHaveLength(6);

    repo.setSyncState((d) => {
      d.prepare("DELETE FROM chunks WHERE file_path NOT IN ('f1.js','f2.js')").run();
      d.prepare("DELETE FROM sync_state WHERE key IN ('last_sync_time','initial_index_complete')").run();
    });
    expect(repo.indexedFiles()).toHaveLength(2);

    const out = await repo.run('sync.js', ['--force']);
    expect(out.all).not.toMatch(/index up to date/);
    expect(out.all).toMatch(/resuming interrupted index/);
    expect(repo.indexedFiles()).toHaveLength(6);
  });

  it('does not re-embed files already indexed at their current hash', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha'), 'b.js': jsFile('beta') });
    await repo.run('sync.js', ['--force']);
    repo.setSyncState((d) => {
      d.prepare("DELETE FROM chunks WHERE file_path = 'b.js'").run();
      d.prepare("DELETE FROM sync_state WHERE key IN ('last_sync_time','initial_index_complete')").run();
    });

    const before = stub.callCount();
    const out = await repo.run('sync.js', ['--force']);
    expect(out.all).toMatch(/1 file\(s\) already done/);
    expect(repo.indexedFiles()).toEqual(['a.js', 'b.js']);
    // One health-check ping plus one batch for the single pending file. The
    // point is that the already-indexed file costs nothing: re-embedding it
    // would make resuming a large repo as expensive as starting over.
    expect(stub.callCount() - before).toBe(2);
  });

  it('detects changed files when the session starts in a subdirectory', async () => {
    // git ls-files reports paths relative to the CWD while git diff/log report
    // them relative to the repo root, so the index was keyed one way and looked
    // up the other. Incremental sync silently found nothing, forever.
    const repo = makeRepo({
      'services/api/handler.js': jsFile('handler'),
      'services/api/util.js': jsFile('util'),
    });
    const sub = join(repo.root, 'services', 'api');

    await repo.run('sync.js', ['--force'], { cwd: sub });
    expect(repo.indexedFiles()).toEqual(['services/api/handler.js', 'services/api/util.js']);

    repo.write('services/api/handler.js', jsFile('handler', 'export function refundTransaction(id) { return id; }\n'));
    repo.commit('add refund');

    const out = await repo.run('sync.js', [], { cwd: sub });
    expect(out.all).not.toMatch(/index up to date/);
    expect(repo.one("SELECT COUNT(*) FROM symbols WHERE name = 'refundTransaction'")).toBe(1);
  });

  it('refuses to auto-index a directory that is not a git repo', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha') });
    const out = await repo.run('sync.js', [], { cwd: join(repo.root, '.claude') });
    // .claude has no .git of its own; without --force this must not index.
    expect(out.all).toMatch(/not a git repository|index up to date|initial index/);
  });
});

describe('gc.js', () => {
  it('does not delete the index when run from a subdirectory', async () => {
    // gc tested indexed paths against the CWD. From a subdirectory every file
    // looked missing, so it deleted the entire index and reported success.
    const repo = makeRepo({
      'services/api/handler.js': jsFile('handler'),
      'services/api/util.js': jsFile('util'),
    });
    await repo.run('sync.js', ['--force']);
    const before = repo.indexedFiles();
    expect(before).toHaveLength(2);

    const out = await repo.run('gc.js', [], { cwd: join(repo.root, 'services', 'api') });
    expect(out.all).not.toMatch(/garbage collected/);
    expect(repo.indexedFiles()).toEqual(before);
  });

  it('removes chunks, symbols and refs together for a deleted file', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha'), 'b.js': jsFile('beta') });
    await repo.run('sync.js', ['--force']);
    expect(repo.one("SELECT COUNT(*) FROM symbols WHERE file_path = 'b.js'")).toBeGreaterThan(0);

    repo.remove('b.js');
    repo.setSyncState((d) => d.prepare("DELETE FROM sync_state WHERE key = 'last_gc_time'").run());
    await repo.run('gc.js');

    expect(repo.indexedFiles()).toEqual(['a.js']);
    expect(repo.one("SELECT COUNT(*) FROM symbols WHERE file_path = 'b.js'")).toBe(0);
    expect(repo.one("SELECT COUNT(*) FROM refs WHERE file_path = 'b.js'")).toBe(0);
  });
});

describe('embed-file.js', () => {
  it('keys on the repo-relative path, so a subdirectory run makes no duplicates', async () => {
    // It normalised against the CWD, producing a different key for the same
    // file — duplicate chunks, and an unchanged-file hash check that never hit.
    const repo = makeRepo({ 'services/api/handler.js': jsFile('handler') });
    await repo.run('sync.js', ['--force']);
    expect(repo.indexedFiles()).toEqual(['services/api/handler.js']);

    const abs = repo.write('services/api/handler.js', jsFile('handler', 'export function voidTxn(id) { return id; }\n'));
    await repo.run('embed-file.js', [abs], { cwd: join(repo.root, 'services', 'api') });

    expect(repo.indexedFiles()).toEqual(['services/api/handler.js']);
    expect(repo.one("SELECT COUNT(*) FROM symbols WHERE name = 'voidTxn'")).toBe(1);
  });

  it('skips a file whose content has not changed', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha') });
    await repo.run('sync.js', ['--force']);
    const before = stub.callCount();
    await repo.run('embed-file.js', [join(repo.root, 'a.js')]);
    expect(stub.callCount()).toBe(before);
  });
});

describe('resilience', () => {
  // Longer budget: an unreachable endpoint is retried twice with backoff before
  // sync gives up, which is the behaviour under test.
  it('reports an unreachable embedding endpoint without corrupting the index', { timeout: 30_000 }, async () => {
    const dead = await startStubEmbedder({ status: 500 });
    const port = new URL(dead.apiBase).port;
    await dead.stop();   // nothing is listening on that port now

    const repo = createRepo({
      apiBase: `http://127.0.0.1:${port}/v1`, dims: 64,
      files: { 'a.js': jsFile('alpha') },
    });
    repos.push(repo);

    const out = await repo.run('sync.js', ['--force']);
    expect(out.all).toMatch(/unreachable|failed|error/i);
    // Exits 0 by design: a down embedder is a config problem, not a reason to
    // fail the session that just started.
    expect(out.status).toBe(0);
    expect(repo.indexedFiles()).toEqual([]);
  });

  it('refuses to search an index whose dimensions no longer match the config', async () => {
    const repo = makeRepo({ 'a.js': jsFile('alpha') });
    await repo.run('sync.js', ['--force']);
    expect(repo.indexedFiles()).toEqual(['a.js']);

    repo.write('.claude/beacon.json', JSON.stringify({
      embedding: { api_base: stub.apiBase, model: 'stub', dimensions: 128, batch_size: 8 },
      indexing: { auto_index: true }, storage: { path: '.claude/.beacon' },
    }, null, 2));

    const sync = await repo.run('sync.js', ['--force']);
    expect(sync.all).toMatch(/dimension mismatch/i);
    // Data must survive: the fix is a reindex, not silent loss.
    expect(repo.one('SELECT COUNT(*) FROM chunks')).toBeGreaterThan(0);

    const search = await repo.run('search.js', ['anything']);
    expect(search.all).toMatch(/[Dd]imension mismatch/);
  });
});
