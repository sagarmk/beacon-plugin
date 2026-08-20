#!/usr/bin/env node
// Called by: /terminate-indexer command
// Purpose: kill a running sync process and clean up state

import { openDatabase } from './lib/open-db.js';
import { loadConfig } from './lib/config.js';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

// A PID file only survives an unclean exit, and by then the OS may have handed
// that number to something else. Signalling it blind would kill an unrelated
// process, so confirm the PID is actually a Beacon sync before touching it.
function isBeaconSync(pid) {
  try {
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf-8' });
    if (out.status !== 0) return false;
    const cmd = (out.stdout || '').trim();
    return cmd.includes('sync.js') && cmd.includes('node');
  } catch {
    return false;   // cannot verify -> do not kill
  }
}

const config = loadConfig();
const dbDir = path.resolve(config.storage.path);
const pidFile = path.join(dbDir, 'sync.pid');
const dbPath = path.join(dbDir, 'embeddings.db');

// Read PID file
if (!existsSync(pidFile)) {
  console.log(JSON.stringify({ status: 'no_process', message: 'No sync process is currently running (no PID file found).' }, null, 2));
  process.exit(0);
}

const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
if (isNaN(pid)) {
  console.log(JSON.stringify({ status: 'error', message: 'Invalid PID file contents.' }, null, 2));
  try { unlinkSync(pidFile); } catch { /* ignore */ }
  process.exit(0);
}

// Try to kill the process
let killed = false;
if (!isBeaconSync(pid)) {
  try { unlinkSync(pidFile); } catch { /* ignore */ }
  console.log(JSON.stringify({
    status: 'cleaned', pid,
    message: `PID ${pid} is not a Beacon sync process (stale PID file). Removed the file without signalling it.`,
  }, null, 2));
  process.exit(0);
}
try {
  process.kill(pid, 'SIGTERM');
  killed = true;
} catch (err) {
  if (err.code === 'ESRCH') {
    // Process doesn't exist — stale PID file
    killed = false;
  } else {
    console.log(JSON.stringify({ status: 'error', message: `Failed to kill process ${pid}: ${err.message}` }, null, 2));
    process.exit(1);
  }
}

// Clean up PID file
try { unlinkSync(pidFile); } catch { /* ignore */ }

// Clean up DB sync state
if (existsSync(dbPath)) {
  let db;
  try {
    db = openDatabase(dbPath, config.embedding.dimensions);
    db.clearSyncProgress();
    db.setSyncState('sync_status', 'idle');
  } catch (err) {
    console.error(`Beacon: warning — failed to clean up DB state: ${err.message}`);
  } finally {
    db?.close();
  }
}

if (killed) {
  console.log(JSON.stringify({ status: 'terminated', pid, message: `Sync process ${pid} terminated and state cleaned up.` }, null, 2));
} else {
  console.log(JSON.stringify({ status: 'cleaned', pid, message: `Sync process ${pid} was not running (stale PID). Cleaned up state.` }, null, 2));
}
