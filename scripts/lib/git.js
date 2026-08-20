import { execSync } from 'child_process';
import { readFileSync, readdirSync, statSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { getRepoRoot } from './repo-root.js';

// Every git subcommand runs from the repo root so they all report paths against
// the same base. Run from a subdirectory, `git ls-files` prints paths relative
// to the CWD while `git diff`/`git log` print them relative to the repo root —
// so the full index keyed chunks one way and the incremental sync looked them
// up the other, and no changed file ever matched.
const gitOpts = () => ({ encoding: 'utf-8', cwd: getRepoRoot() });

// Repo-relative paths are the currency everywhere; resolve against the root,
// never against wherever the session happened to start.
export const resolveRepoPath = (p) => path.resolve(getRepoRoot(), p);

export function isGitRepo() {
  try {
    execSync('git rev-parse --git-dir', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Recursively walk a directory, returning relative file paths
// Skips common non-code directories (node_modules, .venv, .git, etc.)
function walkDirectory(dir, baseDir = dir, maxFiles = 10000, counter = { count: 0 }) {
  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next',
    'dist', 'build', '.claude', '.beacon', '.DS_Store', '.vscode', '.idea'
  ]);

  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (counter.count >= maxFiles) break;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;

    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDirectory(fullPath, baseDir, maxFiles, counter));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, fullPath));
      counter.count++;
    }
  }
  return results;
}

export function getRepoFiles(maxFiles = 10000) {
  if (isGitRepo()) {
    try {
      // Tracked files
      const tracked = execSync('git ls-files', gitOpts());
      // Untracked files (respects .gitignore)
      const untracked = execSync('git ls-files --others --exclude-standard', gitOpts());

      const all = new Set([
        ...tracked.trim().split('\n'),
        ...untracked.trim().split('\n'),
      ].filter(Boolean));

      const files = [...all];
      if (files.length > maxFiles) {
        console.warn(`Beacon: repo has ${files.length} files, capping at ${maxFiles}. Increase indexing.max_files in .claude/beacon.json if needed.`);
        return files.slice(0, maxFiles);
      }
      return files;
    } catch {
      // git command failed — fall through to directory walk
    }
  }

  // Fallback: walk directory tree for non-git repos
  const files = walkDirectory(getRepoRoot(), getRepoRoot(), maxFiles);
  if (files.length >= maxFiles) {
    console.warn(`Beacon: directory walk hit ${maxFiles} file limit. Increase indexing.max_files in .claude/beacon.json if needed.`);
  }
  return files;
}

export function getFileHash(filePath) {
  const content = readFileSync(resolveRepoPath(filePath));
  return createHash('sha256').update(content).digest('hex');
}

export function getModifiedFilesSince(isoTimestamp) {
  if (!isGitRepo()) {
    // No git — return all files (forces full re-check every sync)
    return getRepoFiles();
  }

  try {
    // Files changed in commits since timestamp
    const committed = execSync(
      `git log --since="${isoTimestamp}" --name-only --pretty=format:""`,
      gitOpts()
    );
    // Currently modified (unstaged + staged) files
    const modified = execSync('git diff --name-only HEAD', gitOpts());
    // Untracked files
    const untracked = execSync('git ls-files --others --exclude-standard', gitOpts());

    const allFiles = new Set([
      ...committed.trim().split('\n'),
      ...modified.trim().split('\n'),
      ...untracked.trim().split('\n'),
    ].filter(Boolean));

    return [...allFiles];
  } catch {
    return [];
  }
}
