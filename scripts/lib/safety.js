import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'fs';
import path from 'path';
import os from 'os';

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.claude', 'beacon-global.json');

export function loadGlobalConfig() {
  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    const dir = path.dirname(GLOBAL_CONFIG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const defaults = { blacklist: [], whitelist: [] };
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    return JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
  } catch {
    return { blacklist: [], whitelist: [] };
  }
}

export function saveGlobalConfig(config) {
  const dir = path.dirname(GLOBAL_CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Computed default blacklist: all ancestor dirs from / to homedir
// e.g. /, /Users, /Users/<username>
function getDefaultBlacklist() {
  const home = os.homedir();
  const parts = home.split(path.sep).filter(Boolean);
  const ancestors = ['/'];
  let current = '/';
  for (const part of parts) {
    current = path.join(current, part);
    ancestors.push(current);
  }
  return ancestors;
}

export function getEffectiveBlacklist() {
  const config = loadGlobalConfig();
  const defaults = getDefaultBlacklist();
  const userEntries = config.blacklist || [];
  // Merge and deduplicate
  return [...new Set([...defaults, ...userEntries])];
}

// process.cwd() always reports the resolved path, while a configured entry is
// whatever the user typed. On macOS /tmp and /var/folders are symlinks, and
// symlinked project directories are common — so comparing the two forms
// silently never matched, and the blacklist did nothing at all in those trees.
const realPath = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

export function isCwdBlacklisted() {
  const cwd = realPath(process.cwd());
  const config = loadGlobalConfig();
  const whitelist = config.whitelist || [];

  // Whitelist takes precedence — exact match or cwd is under a whitelisted path
  for (const w of whitelist) {
    const resolved = realPath(w);
    if (cwd === resolved || cwd.startsWith(resolved + path.sep)) {
      return false;
    }
  }

  // The computed ancestor defaults must stay exact-match. They are every
  // directory from / up to the home directory, so making them inherit would
  // blacklist the entire filesystem and nothing would ever index.
  const defaults = new Set(getDefaultBlacklist().map((d) => realPath(d)));
  for (const b of getEffectiveBlacklist()) {
    const resolved = realPath(b);
    if (cwd === resolved) return true;
    // A user-added entry inherits, matching how the whitelist already behaves.
    // Exact-only matching meant blacklisting a directory did nothing for
    // anything beneath it — which is how a home Documents folder ended up fully
    // indexed despite /Users/<name> being on the list.
    if (!defaults.has(resolved) && cwd.startsWith(resolved + path.sep)) return true;
  }
  return false;
}

export function isCwdWhitelisted() {
  const cwd = realPath(process.cwd());
  const config = loadGlobalConfig();
  const whitelist = config.whitelist || [];
  for (const w of whitelist) {
    const resolved = realPath(w);
    if (cwd === resolved || cwd.startsWith(resolved + path.sep)) {
      return true;
    }
  }
  return false;
}

export { GLOBAL_CONFIG_PATH };
