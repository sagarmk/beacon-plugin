import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeModules = join(pluginRoot, "node_modules");

// Checking only that node_modules exists treats a half-finished install as
// success: an interrupted first run leaves the directory behind, and Beacon
// then fails on a missing module every session with no way to recover.
// Verify the packages actually required are present.
const REQUIRED = ["better-sqlite3", "sqlite-vec", "picomatch"];
const depsUsable = existsSync(nodeModules) && REQUIRED.every((d) => existsSync(join(nodeModules, d)));

if (!depsUsable) {
  process.stderr.write("Beacon: installing dependencies (first run)...\n");
  try {
    execFileSync("npm", ["install", "--production", "--no-audit", "--no-fund"], {
      cwd: pluginRoot,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stderr.write("Beacon: dependencies installed successfully.\n");
  } catch (err) {
    process.stderr.write(
      `Beacon: failed to install dependencies. Run 'npm install' manually in ${pluginRoot}\n`
    );
    if (err.stderr) process.stderr.write(err.stderr.toString());
    process.exit(1);
  }
}
