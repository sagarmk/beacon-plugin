import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import picomatch from 'picomatch';
import { getRepoRoot } from './repo-root.js';

let beaconIgnorePatterns = null;

function loadBeaconIgnore() {
  if (beaconIgnorePatterns !== null) return beaconIgnorePatterns;

  const beaconIgnorePath = path.join(getRepoRoot(), '.beaconignore');
  if (existsSync(beaconIgnorePath)) {
    beaconIgnorePatterns = readFileSync(beaconIgnorePath, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } else {
    beaconIgnorePatterns = [];
  }
  return beaconIgnorePatterns;
}

export function shouldIndex(filePath, config) {
  // Normalize to forward slashes for consistent matching
  const normalized = filePath.replace(/\\/g, '/');

  // 1. Must match at least one include pattern
  const included = config.indexing.include.some(pattern =>
    picomatch.isMatch(normalized, pattern)
  );
  if (!included) return false;

  // 2. Must not match any exclude pattern
  const excluded = config.indexing.exclude.some(pattern =>
    picomatch.isMatch(normalized, pattern)
  );
  if (excluded) return false;

  // 3. Must not match any .beaconignore pattern
  const ignorePatterns = loadBeaconIgnore();
  if (ignorePatterns.some(pattern => picomatch.isMatch(normalized, pattern))) {
    return false;
  }

  // 4. Check file size — filePath is repo-relative, so resolve it against the
  // repo root rather than the CWD, or every file silently fails this check
  // whenever the session starts in a subdirectory.
  try {
    const stats = statSync(path.resolve(getRepoRoot(), filePath));
    if (stats.size > config.indexing.max_file_size_kb * 1024) return false;
  } catch {
    return false; // file doesn't exist or inaccessible
  }

  return true;
}
