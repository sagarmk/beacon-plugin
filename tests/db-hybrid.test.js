import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BeaconDatabase, SCHEMA_VERSION } from '../scripts/lib/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DIMENSIONS = 4; // tiny embeddings for testing

function makeEmbedding(values) {
  // Pad/truncate to DIMENSIONS
  const arr = new Array(DIMENSIONS).fill(0);
  for (let i = 0; i < Math.min(values.length, DIMENSIONS); i++) {
    arr[i] = values[i];
  }
  return arr;
}

describe('BeaconDatabase hybrid search', () => {
  let db;
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'beacon-test-'));
    db = new BeaconDatabase(join(tmpDir, 'test.db'), DIMENSIONS);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('schema migration', () => {
    it('creates FTS table on init', () => {
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'"
      ).all();
      expect(tables).toHaveLength(1);
    });

    it('adds identifiers column', () => {
      const cols = db.db.pragma('table_info(chunks)');
      expect(cols.some(c => c.name === 'identifiers')).toBe(true);
    });

    it('stamps the current schema version', () => {
      // Tracks the constant rather than a literal, so a version bump does not
      // need this test edited to keep passing.
      expect(db.getSyncState('schema_version')).toBe(String(SCHEMA_VERSION));
    });

    it('migration is idempotent', () => {
      // Opening a second connection should not fail
      const db2 = new BeaconDatabase(join(tmpDir, 'test.db'), DIMENSIONS);
      expect(db2.getSyncState('schema_version')).toBe(String(SCHEMA_VERSION));
      db2.close();
    });

    it('creates the symbol graph tables', () => {
      const names = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('symbols','refs')"
      ).all().map(r => r.name).sort();
      expect(names).toEqual(['refs', 'symbols']);
    });
  });

  describe('FTS sync in CRUD operations', () => {
    it('upsertChunk populates FTS', () => {
      db.upsertChunk('src/auth.ts', 0, 'function signInWithGoogle() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash1', 'signInWithGoogle sign In With Google');

      const ftsRows = db.db.prepare('SELECT * FROM chunks_fts').all();
      expect(ftsRows).toHaveLength(1);
      expect(ftsRows[0].identifiers).toContain('signInWithGoogle');
    });

    it('upsertChunk updates FTS on re-upsert', () => {
      db.upsertChunk('src/auth.ts', 0, 'function oldFunction() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash1', 'oldFunction');

      db.upsertChunk('src/auth.ts', 0, 'function newFunction() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash2', 'newFunction');

      // Search for new content
      const results = db.db.prepare(
        "SELECT * FROM chunks_fts WHERE chunks_fts MATCH '\"newFunction\"'"
      ).all();
      expect(results).toHaveLength(1);

      // Old content should not be findable
      const oldResults = db.db.prepare(
        "SELECT * FROM chunks_fts WHERE chunks_fts MATCH '\"oldFunction\"'"
      ).all();
      expect(oldResults).toHaveLength(0);
    });

    it('deleteFileChunks removes FTS rows', () => {
      db.upsertChunk('src/auth.ts', 0, 'function signIn() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash1', 'signIn');
      db.upsertChunk('src/auth.ts', 1, 'function signOut() {}', 6, 10,
        makeEmbedding([0, 1, 0, 0]), 'hash1', 'signOut');

      db.deleteFileChunks('src/auth.ts');

      const ftsRows = db.db.prepare('SELECT * FROM chunks_fts').all();
      expect(ftsRows).toHaveLength(0);
    });

    it('deleteOrphanChunks removes FTS rows for orphans', () => {
      db.upsertChunk('src/auth.ts', 0, 'function keep() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash1', 'keep');
      db.upsertChunk('src/auth.ts', 1, 'function orphan() {}', 6, 10,
        makeEmbedding([0, 1, 0, 0]), 'hash1', 'orphan');

      db.deleteOrphanChunks('src/auth.ts', 0); // keep only chunk 0

      const ftsRows = db.db.prepare('SELECT * FROM chunks_fts').all();
      expect(ftsRows).toHaveLength(1);
      expect(ftsRows[0].chunk_text).toContain('keep');
    });

    it('auto-computes identifiers when not provided', () => {
      db.upsertChunk('src/utils.ts', 0, 'export function camelCaseHelper() {}', 1, 5,
        makeEmbedding([1, 0, 0, 0]), 'hash1');

      const chunk = db.db.prepare('SELECT identifiers FROM chunks WHERE file_path = ?').get('src/utils.ts');
      expect(chunk.identifiers).toContain('camelCaseHelper');
    });
  });

  describe('hybrid search', () => {
    const hybridConfig = {
      search: {
        hybrid: {
          enabled: true,
          weight_vector: 0.4,
          weight_bm25: 0.3,
          weight_rrf: 0.3,
          debug: false,
        }
      }
    };

    beforeEach(() => {
      // Insert test data: a code file and a README
      db.upsertChunk('src/auth.ts', 0,
        'export function signInWithGoogle(provider: string) { return firebase.auth().signInWithPopup(provider); }',
        1, 5, makeEmbedding([0.9, 0.1, 0, 0]), 'hash1');

      db.upsertChunk('README.md', 0,
        'This project uses Google authentication via signInWithGoogle. See docs for details.',
        1, 3, makeEmbedding([0.8, 0.2, 0, 0]), 'hash2');

      db.upsertChunk('src/utils.ts', 0,
        'export function formatDate(date: Date) { return date.toISOString(); }',
        1, 3, makeEmbedding([0.1, 0.1, 0.9, 0]), 'hash3');
    });

    it('falls back to vector search when hybrid disabled', () => {
      const disabledConfig = { search: { hybrid: { enabled: false } } };
      const results = db.search(makeEmbedding([0.9, 0.1, 0, 0]), 10, 0.0, 'test', disabledConfig);
      expect(results.length).toBeGreaterThan(0);
      // Should not have score field (pure vector)
      expect(results[0].score).toBeUndefined();
    });

    it('falls back to vector search when no queryText', () => {
      const results = db.search(makeEmbedding([0.9, 0.1, 0, 0]), 10, 0.0, null, hybridConfig);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeUndefined();
    });

    it('returns hybrid results with score field', () => {
      const results = db.search(
        makeEmbedding([0.9, 0.1, 0, 0]), 10, 0.0,
        'signInWithGoogle function', hybridConfig
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeDefined();
    });

    it('ranks source code above README for identifier queries', () => {
      const results = db.search(
        makeEmbedding([0.85, 0.15, 0, 0]), 10, 0.0,
        'signInWithGoogle function', hybridConfig
      );

      const authIdx = results.findIndex(r => r.filePath === 'src/auth.ts');
      const readmeIdx = results.findIndex(r => r.filePath === 'README.md');

      // src/auth.ts should rank above README.md due to file type penalty + identifier boost
      expect(authIdx).toBeLessThan(readmeIdx);
    });

    it('respects topK limit', () => {
      const results = db.search(
        makeEmbedding([0.9, 0.1, 0, 0]), 1, 0.0,
        'signInWithGoogle', hybridConfig
      );
      expect(results).toHaveLength(1);
    });

    it('includes debug info when enabled', () => {
      const debugConfig = {
        search: { hybrid: { ...hybridConfig.search.hybrid, enabled: true, debug: true } }
      };
      const results = db.search(
        makeEmbedding([0.9, 0.1, 0, 0]), 10, 0.0,
        'signInWithGoogle', debugConfig
      );
      expect(results[0]._debug).toBeDefined();
      expect(results[0]._debug.fileMultiplier).toBeDefined();
    });
  });
});
