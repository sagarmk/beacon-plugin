import { execSync } from 'child_process';

// Cached per working directory. A single module-level cache returned a stale
// root once the process changed directory, which silently pointed every
// repo-relative path at the wrong tree.
const _roots = new Map();

export function getRepoRoot() {
  const cwd = process.cwd();
  if (_roots.has(cwd)) return _roots.get(cwd);
  let root;
  try {
    root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = cwd; // not a git repo
  }
  _roots.set(cwd, root);
  return root;
}
