// Shared helper: opens BeaconDatabase with auto-rebuild on Node.js ABI mismatch.
// All scripts that open the DB should use this instead of direct instantiation.

import { BeaconDatabase } from './db.js';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { unlinkSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

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

    if (!err.message.includes('NODE_MODULE_VERSION')) throw err;

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
