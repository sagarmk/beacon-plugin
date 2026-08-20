// Shared helper: opens BeaconDatabase with auto-rebuild on Node.js ABI mismatch.
// All scripts that open the DB should use this instead of direct instantiation.

import { BeaconDatabase } from './db.js';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

// A native module can be unusable in more ways than an ABI mismatch, and only
// one of them says NODE_MODULE_VERSION. `npm install --production` can leave
// better-sqlite3's directory in place with no compiled binary at all — the
// prebuild download fails, the source build is skipped, and the package looks
// installed. That surfaces as "Could not locate the bindings file", which the
// old check did not match, so the rebuild that would have fixed it never ran
// and every Beacon command died on a fresh install.
export function needsNativeRebuild(err) {
  const m = String(err && err.message);
  return m.includes('NODE_MODULE_VERSION')          // built for another Node ABI
    || m.includes('Could not locate the bindings')   // never built at all
    || m.includes('invalid ELF header')              // built for another platform
    || m.includes('was compiled against a different') // node-gyp phrasing
    || m.includes('mach-o, but wrong architecture')  // arm64 vs x64 on macOS
    || m.includes('symbol not found');               // partially linked binary
}

export function openDatabase(dbPath, dimensions) {
  try {
    return new BeaconDatabase(dbPath, dimensions);
  } catch (err) {
    // Auto-recover from DB corruption — the index is fully regenerable
    if (err.message.includes('database disk image is malformed') || err.message.includes('file is not a database')) {
      console.warn(`Beacon: database corrupted (${err.message}). Deleting — will rebuild on next sync.`);
      try { unlinkSync(dbPath); } catch { /* already gone */ }
      try { unlinkSync(dbPath + '-wal'); } catch { /* no WAL file */ }
      try { unlinkSync(dbPath + '-shm'); } catch { /* no SHM file */ }
      return new BeaconDatabase(dbPath, dimensions);
    }

    if (!needsNativeRebuild(err)) throw err;

    // Guard against infinite re-exec loop
    if (process.env.__BEACON_REEXEC) {
      throw new Error(`Native module still incompatible after rebuild: ${err.message}`);
    }

    // stderr, not stdout: callers of this function emit JSON on stdout, and the
    // MCP server writes JSON-RPC frames there. A progress line printed to stdout
    // lands mid-payload and corrupts whatever the caller was producing.
    console.error('Beacon: Node.js version changed — rebuilding native modules...');
    const rebuild = spawnSync('npm', ['rebuild'], {
      cwd: PLUGIN_ROOT,
      stdio: 'pipe',
      timeout: 60_000,
    });

    if (rebuild.status !== 0) {
      const stderr = rebuild.stderr?.toString().trim();
      throw new Error(`npm rebuild failed (exit ${rebuild.status}): ${stderr}`);
    }

    console.error('Beacon: rebuild successful, re-executing...');
    const child = spawnSync(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, __BEACON_REEXEC: '1' },
    });

    process.exit(child.status ?? 1);
  }
}
