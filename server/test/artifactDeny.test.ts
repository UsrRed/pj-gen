import { describe, expect, it } from 'vitest';
import { isSecretArtifact } from '../src/pipeline/artifacts.js';

/**
 * The artifacts tree hides dotfiles, but the read-by-path route does not walk the tree:
 * without a deny-list `?path=.env` returns the project's secrets verbatim — and
 * `settings.exposeLan` publishes that API on the LAN with no auth.
 */
describe('artifact deny-list', () => {
  it('blocks secret-bearing paths', () => {
    for (const p of [
      '.env',
      '.env.local',
      '.env.production',
      './.env',
      'server/.env',
      '.git/config',
      '.git/hooks/commit-msg',
      '.npmrc',
      'deploy/id_ed25519',
      'certs/server.key',
      'certs/chain.pem',
    ]) {
      expect(isSecretArtifact(p), p).toBe(true);
    }
  });

  it('lets ordinary artifacts through', () => {
    for (const p of [
      'docs/SPEC.md',
      'docs/ARCHITECTURE.md',
      'src/index.ts',
      'package.json',
      'README.md',
      'docs/design/mockup.html',
      // near-misses that must NOT be blocked
      'src/environment.ts',
      'docs/keyboard.md',
      'src/gitignore-parser.ts',
    ]) {
      expect(isSecretArtifact(p), p).toBe(false);
    }
  });

  it('lets .env TEMPLATES through — they are committed and carry no secret', () => {
    for (const p of ['.env.example', '.env.sample', '.env.template', '.env.dist', 'server/.env.example']) {
      expect(isSecretArtifact(p), p).toBe(false);
    }
    // …while the real file stays blocked, including its per-environment variants.
    for (const p of ['.env', '.env.local', '.env.production']) {
      expect(isSecretArtifact(p), p).toBe(true);
    }
  });
});
