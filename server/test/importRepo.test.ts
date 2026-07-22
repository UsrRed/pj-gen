import { describe, expect, it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Container } from '../src/container.js';
import { testContainer } from './helpers.js';
import { auditCommits } from '../src/pipeline/attribution.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...env } }).toString();
}

const FOREIGN = {
  GIT_AUTHOR_NAME: 'Somebody Else',
  GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Somebody Else',
  GIT_COMMITTER_EMAIL: 'someone@example.com',
};

describe('imported repository adoption', () => {
  it('adopts a foreign clone: UsrRed identity, import-base marker, audit ignores foreign history', async () => {
    const { c } = await testContainer();
    cRef = c;
    // Simulate a cloned repo with foreign-authored history.
    const ws = c.ws.pathFor('imported-repo');
    fs.mkdirSync(ws, { recursive: true });
    git(ws, ['init', '-b', 'main']);
    git(ws, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(ws, 'index.js'), 'console.log("hello");\n');
    git(ws, ['add', '-A'], FOREIGN);
    git(ws, ['commit', '-m', 'initial commit\n\nCo-Authored-By: Claude <noreply@anthropic.com>'], FOREIGN);

    await c.ws.adoptClone('imported-repo', 'imported-repo');

    // Marker + UsrRed identity + docs files present, adoption commit authored by UsrRed.
    expect(git(ws, ['config', 'pjgen.import-base']).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(git(ws, ['config', 'user.name']).trim()).toBe('UsrRed');
    expect(fs.existsSync(path.join(ws, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'docs', 'PROGRESS.md'))).toBe(true);
    expect(git(ws, ['log', '-1', '--format=%an']).trim()).toBe('UsrRed');

    // The foreign commit (wrong author + forbidden trailer) is BEFORE the marker → audit passes.
    const audit = await auditCommits(ws);
    expect(audit.ok).toBe(true);

    // A post-import commit with a foreign author IS caught.
    fs.writeFileSync(path.join(ws, 'other.js'), 'x\n');
    git(ws, ['add', '-A'], FOREIGN);
    git(ws, ['commit', '-m', 'later change', '--no-verify'], FOREIGN);
    const audit2 = await auditCommits(ws);
    expect(audit2.ok).toBe(false);
    expect(audit2.issues.some((i) => i.reason.includes('author inattendu'))).toBe(true);
  });
});
