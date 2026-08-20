import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import path from 'path';

// We need to mock the global config path so tests don't touch the real config
let tmpDir;
let mockConfigPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'beacon-safety-test-'));
  mockConfigPath = join(tmpDir, 'beacon-global.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Import after setup so we can mock
describe('safety.js', () => {
  // We'll test the functions by importing fresh each time with mocked config path
  // Since safety.js uses a constant path, we'll test the logic directly

  it('loadGlobalConfig creates default config if missing', async () => {
    const { loadGlobalConfig, saveGlobalConfig, GLOBAL_CONFIG_PATH } = await import('../scripts/lib/safety.js');
    // The real function creates at ~/.claude/beacon-global.json
    // We just verify it returns the right shape
    const config = loadGlobalConfig();
    expect(config).toHaveProperty('blacklist');
    expect(config).toHaveProperty('whitelist');
    expect(Array.isArray(config.blacklist)).toBe(true);
    expect(Array.isArray(config.whitelist)).toBe(true);
  });

  it('getEffectiveBlacklist includes home directory ancestors', async () => {
    const { getEffectiveBlacklist } = await import('../scripts/lib/safety.js');
    const effective = getEffectiveBlacklist();
    const home = homedir();

    // Should include /
    expect(effective).toContain('/');
    // Should include the home directory itself
    expect(effective).toContain(home);
    // Should include parent of home
    expect(effective).toContain(path.dirname(home));
  });

  it('isCwdBlacklisted returns false for normal project directories', async () => {
    const { isCwdBlacklisted } = await import('../scripts/lib/safety.js');
    // cwd is the Beacon project dir, which should NOT be blacklisted
    // (it's a subdirectory of home, not home itself)
    const result = isCwdBlacklisted();
    expect(result).toBe(false);
  });
});

describe('blacklist inheritance', () => {
  let tmpHome, origHome;
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'beacon-home-'));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it('a user-blacklisted directory also blocks everything beneath it', async () => {
    const { saveGlobalConfig, isCwdBlacklisted } = await import('../scripts/lib/safety.js');
    const secrets = join(tmpHome, 'secrets');
    const nested = join(secrets, 'deep', 'inner');
    mkdirSync(nested, { recursive: true });
    saveGlobalConfig({ blacklist: [secrets], whitelist: [] });

    const prev = process.cwd();
    try {
      process.chdir(nested);
      // Exact-only matching is what let a home Documents folder index despite
      // its parent being listed.
      expect(isCwdBlacklisted()).toBe(true);
    } finally { process.chdir(prev); }
  });

  it('ancestor defaults stay exact so projects under home still index', async () => {
    const { isCwdBlacklisted } = await import('../scripts/lib/safety.js');
    const project = join(tmpHome, 'code', 'my-project');
    mkdirSync(project, { recursive: true });
    const prev = process.cwd();
    try {
      process.chdir(project);
      // HOME itself is a computed default; if defaults inherited, every project
      // beneath it would be blocked and nothing would ever index.
      expect(isCwdBlacklisted()).toBe(false);
    } finally { process.chdir(prev); }
  });
});
