import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModules = join(pluginRoot, "node_modules");
const require = createRequire(pathToFileURL(join(pluginRoot, "noop.js")));

// Checking that node_modules exists treats a half-finished install as success:
// an interrupted first run leaves the directory behind and Beacon then fails on
// a missing module every session with no path to recovery.
//
// Checking that each package *directory* exists is not enough either.
// `npm install --omit=dev` can leave better-sqlite3 fully unpacked with no
// compiled binary inside it — the prebuild download fails, the source build is
// skipped, and every path check passes.
//
// Requiring the module is also not enough: better-sqlite3 resolves its native
// binding lazily on first construction, so `require` returns a working function
// with zero .node files on disk. The only honest test is to open a database.
const PURE_JS = ["picomatch", "sqlite-vec"];

function depsUsable() {
  if (!existsSync(nodeModules)) return false;
  if (!PURE_JS.every((d) => existsSync(join(nodeModules, d)))) return false;
  try {
    const Database = require("better-sqlite3");
    new Database(":memory:").close();   // forces the native binding to load
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, {
    cwd: pluginRoot,
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

if (!depsUsable()) {
  process.stderr.write("Beacon: installing dependencies (first run)...\n");
  try {
    run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"]);
  } catch (err) {
    process.stderr.write(
      `Beacon: failed to install dependencies. Run 'npm install' manually in ${pluginRoot}\n`
    );
    if (err.stderr) process.stderr.write(err.stderr.toString());
    process.exit(1);
  }

  // Install can succeed while the native addon is still missing, so verify by
  // loading it and rebuild from source if it will not load. Without this the
  // plugin installs "successfully" and then fails on every command.
  if (!depsUsable()) {
    process.stderr.write("Beacon: native module missing after install — rebuilding...\n");
    try {
      run("npm", ["rebuild", "better-sqlite3"]);
    } catch (err) {
      process.stderr.write(
        `Beacon: could not build better-sqlite3. Run 'npm rebuild better-sqlite3' in ${pluginRoot}\n`
      );
      if (err.stderr) process.stderr.write(err.stderr.toString());
      process.exit(1);
    }
  }

  if (!depsUsable()) {
    process.stderr.write(
      `Beacon: dependencies still unusable after install and rebuild. See ${pluginRoot}\n`
    );
    process.exit(1);
  }
  process.stderr.write("Beacon: dependencies installed successfully.\n");
}
