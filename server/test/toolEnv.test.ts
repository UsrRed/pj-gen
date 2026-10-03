import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildEnv } from '../src/claude/sessionArgs.js';
import { toolEnv } from '../src/core/toolEnv.js';
import { testConfig, tmpDir } from './helpers.js';

describe('toolEnv', () => {
  it('points every package manager at the shared cache root', () => {
    const config = testConfig(tmpDir('env'));
    const env = toolEnv(config);
    expect(env.npm_config_cache).toBe(path.join(config.cacheDir, 'npm'));
    expect(env.PIP_CACHE_DIR).toBe(path.join(config.cacheDir, 'pip'));
    expect(env.CARGO_HOME).toBe(path.join(config.cacheDir, 'cargo'));
    // pip --user installs must survive an image rebuild: the user base sits on the data volume.
    expect(env.PYTHONUSERBASE).toBe(path.join(config.cacheDir, 'python-user'));
    expect(env.npm_config_audit).toBe('false');
  });

  it('sets CI by default and omits it for the preview runner', () => {
    const config = testConfig(tmpDir('env'));
    expect(toolEnv(config).CI).toBe('1');
    // The preview IS a watching dev server — CI=1 there would defeat its purpose.
    expect(toolEnv(config, { ci: false }).CI).toBeUndefined();
  });

  it('derives cacheDir from an overridden dataDir', () => {
    const base = tmpDir('env');
    const config = testConfig(base);
    expect(config.cacheDir.startsWith(config.dataDir)).toBe(true);
  });
});

describe('buildEnv', () => {
  it('adds the shared caches without re-introducing a stripped key', () => {
    const config = testConfig(tmpDir('env'));
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    try {
      const env = buildEnv(config);
      // The Object.assign of toolEnv must stay AFTER the strip loop.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.npm_config_cache).toBe(path.join(config.cacheDir, 'npm'));
      expect(env.CI).toBe('1');
      expect(env.GIT_AUTHOR_NAME).toBe(config.gitAuthorName);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
