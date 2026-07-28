import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { COMMIT_MSG_HOOK } from './attribution.js';
import { generatedClaudeMd } from '../prompts/common.js';

const execFileP = promisify(execFile);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

/**
 * `merge=union` on the progress log: it is append-only, and every parallel task appends
 * to it — without this it is the single most common spurious merge conflict between
 * worktrees. Union concatenates both sides instead of failing.
 */
export const GITATTRIBUTES = 'docs/PROGRESS.md merge=union\n';

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    // strip combining diacritics (é → e)
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  if (SLUG_RE.test(base)) return base;
  const fallback = `projet-${base}`.replace(/[^a-z0-9-]/g, '').replace(/-+$/, '').slice(0, 30);
  return SLUG_RE.test(fallback) ? fallback : 'projet';
}

async function git(workspace: string, config: Config, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileP('git', args, {
    cwd: workspace,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: config.gitAuthorName,
      GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
      GIT_COMMITTER_NAME: config.gitAuthorName,
      GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

export class WorkspaceManager {
  constructor(private config: Config) {}

  pathFor(slug: string): string {
    if (!SLUG_RE.test(slug)) throw new Error(`slug invalide: ${slug}`);
    return path.join(this.config.workspaceRoot, slug);
  }

  exists(slug: string): boolean {
    return fs.existsSync(this.pathFor(slug));
  }

  /** Creates the workspace: git repo (UsrRed identity), attribution hook, CLAUDE.md, docs/. */
  async create(slug: string, title: string): Promise<string> {
    const ws = this.pathFor(slug);
    fs.mkdirSync(this.config.workspaceRoot, { recursive: true });
    fs.mkdirSync(ws, { recursive: false });
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });

    await git(ws, this.config, ['init', '-b', 'main']);
    await git(ws, this.config, ['config', 'user.name', this.config.gitAuthorName]);
    await git(ws, this.config, ['config', 'user.email', this.config.gitAuthorEmail]);
    await git(ws, this.config, ['config', 'commit.gpgsign', 'false']);

    const hookPath = path.join(ws, '.git', 'hooks', 'commit-msg');
    fs.writeFileSync(hookPath, COMMIT_MSG_HOOK, { mode: 0o755 });

    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), generatedClaudeMd(title));
    fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\ndist/\n.env\n*.log\n__pycache__/\n.venv/\n');
    fs.writeFileSync(path.join(ws, '.gitattributes'), GITATTRIBUTES);
    fs.writeFileSync(path.join(ws, 'docs', 'PROGRESS.md'), `# Progression\n\n- ${new Date().toISOString()} — workspace initialisé\n`);

    await this.commitAll(ws, 'chore: initialize workspace');
    return ws;
  }

  /**
   * Adopts an EXISTING repository (freshly cloned into the workspace root):
   * UsrRed identity + attribution hook, `pjgen.import-base` marker so the
   * attribution audit ignores the foreign history, CLAUDE.md/PROGRESS.md if
   * absent, then one adoption commit (authored UsrRed, after the marker).
   */
  async adoptClone(slug: string, title: string): Promise<string> {
    const ws = this.pathFor(slug);
    if (!fs.existsSync(path.join(ws, '.git'))) throw new Error(`pas un dépôt git: ${ws}`);

    await git(ws, this.config, ['config', 'user.name', this.config.gitAuthorName]);
    await git(ws, this.config, ['config', 'user.email', this.config.gitAuthorEmail]);
    await git(ws, this.config, ['config', 'commit.gpgsign', 'false']);
    const base = await this.headSha(ws);
    if (base) await git(ws, this.config, ['config', 'pjgen.import-base', base]);
    fs.writeFileSync(path.join(ws, '.git', 'hooks', 'commit-msg'), COMMIT_MSG_HOOK, { mode: 0o755 });

    if (!fs.existsSync(path.join(ws, 'CLAUDE.md'))) fs.writeFileSync(path.join(ws, 'CLAUDE.md'), generatedClaudeMd(title));
    const attrs = path.join(ws, '.gitattributes');
    const existingAttrs = fs.existsSync(attrs) ? fs.readFileSync(attrs, 'utf8') : '';
    if (!existingAttrs.includes('docs/PROGRESS.md')) fs.appendFileSync(attrs, (existingAttrs && !existingAttrs.endsWith('\n') ? '\n' : '') + GITATTRIBUTES);
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    if (!fs.existsSync(path.join(ws, 'docs', 'PROGRESS.md'))) {
      fs.writeFileSync(path.join(ws, 'docs', 'PROGRESS.md'), `# Progression\n\n- ${new Date().toISOString()} — dépôt importé depuis GitHub\n`);
    }
    await this.commitAll(ws, 'chore: adopt into pj-gen');
    return ws;
  }

  writeFile(workspace: string, relPath: string, content: string): string {
    const abs = this.assertInside(workspace, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  readFile(workspace: string, relPath: string, maxBytes = 512 * 1024): { content: string; truncated: boolean } | null {
    const abs = this.assertInside(workspace, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    const buf = fs.readFileSync(abs);
    return { content: buf.subarray(0, maxBytes).toString('utf8'), truncated: buf.length > maxBytes };
  }

  appendProgress(workspace: string, line: string): void {
    const p = path.join(workspace, 'docs', 'PROGRESS.md');
    fs.appendFileSync(p, `- ${new Date().toISOString()} — ${line}\n`);
  }

  /**
   * True when an actual MOCKUP exists (user-provided or design-step output).
   * Tests specific files, not the docs/design/ folder: the benchmark step also
   * writes there (BENCHMARK.md) and must not count as a mockup.
   */
  hasDesignReference(workspace: string): boolean {
    return ['mockup.html', 'Mockup.jsx', 'NOTES.md', 'README.md'].some((f) =>
      fs.existsSync(path.join(workspace, 'docs', 'design', f))
    );
  }

  /**
   * Stores a design mockup (e.g. exported from Claude Design — claude.ai/design) as the
   * project's visual source of truth: docs/design/ + a binding section in CLAUDE.md.
   */
  writeDesignReference(workspace: string, design: { content?: string; url?: string }, iteration = 1): string[] {
    const written: string[] = [];
    const content = design.content?.trim() ?? '';
    let mockupFile: string | null = null;
    if (content) {
      const head = content.slice(0, 2000);
      // React signals first: JSX also contains HTML-looking tags.
      if (/import\s+React|from\s+['"]react['"]|export\s+(default|function|const)\s/m.test(head)) mockupFile = 'docs/design/Mockup.jsx';
      else if (/^</.test(content) || /<html|<body|<div|<section|<main/i.test(head)) mockupFile = 'docs/design/mockup.html';
      else mockupFile = 'docs/design/NOTES.md';
      this.writeFile(workspace, mockupFile, content);
      written.push(mockupFile);
    }
    const readme = [
      '# Référence visuelle (maquette)',
      '',
      `Source: ${design.url?.trim() || 'maquette fournie par l’opérateur (ex. export Claude Design)'}${iteration > 1 ? ` — mise à jour à l'itération ${iteration}` : ''}`,
      '',
      mockupFile ? `Fichier de maquette: \`${mockupFile.replace('docs/design/', '')}\`` : 'Pas de fichier — voir l’URL source.',
      '',
      'Cette maquette est la référence du rendu final: structure, hiérarchie visuelle, style. Le produit doit s’y conformer.',
    ].join('\n');
    this.writeFile(workspace, 'docs/design/README.md', readme);
    written.push('docs/design/README.md');

    const claudeMdPath = path.join(workspace, 'CLAUDE.md');
    const marker = '## Référence visuelle';
    if (fs.existsSync(claudeMdPath) && !fs.readFileSync(claudeMdPath, 'utf8').includes(marker)) {
      fs.appendFileSync(
        claudeMdPath,
        `\n${marker}\n- \`docs/design/\` contient la maquette de référence (ex. Claude Design). Le rendu final doit s'y conformer: structure, hiérarchie, style.\n- Consulte-la avant toute décision visuelle (layout, composants, thème).\n`
      );
    }
    return written;
  }

  /** Resolves relPath under workspace and rejects any escape (.., absolute paths, symlinks out). */
  assertInside(workspace: string, relPath: string): string {
    if (path.isAbsolute(relPath)) throw new Error('chemin absolu refusé');
    const wsReal = fs.realpathSync(workspace);
    const absTarget = path.resolve(wsReal, relPath);
    if (absTarget !== wsReal && !absTarget.startsWith(wsReal + path.sep)) throw new Error('chemin hors du workspace refusé');
    // If the target exists, also check its realpath (symlink escape).
    let probe = absTarget;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    const probeReal = fs.realpathSync(probe);
    if (probeReal !== wsReal && !probeReal.startsWith(wsReal + path.sep)) throw new Error('chemin hors du workspace refusé (symlink)');
    return absTarget;
  }

  async commitAll(workspace: string, message: string): Promise<string | null> {
    await git(workspace, this.config, ['add', '-A']);
    try {
      await git(workspace, this.config, ['commit', '-m', message]);
    } catch (err) {
      const msg = String((err as { stdout?: string; stderr?: string; message?: string }).stdout ?? '') + String((err as { stderr?: string }).stderr ?? '');
      if (/nothing to commit|rien à valider/i.test(msg)) return null;
      throw err;
    }
    return this.headSha(workspace);
  }

  async headSha(workspace: string): Promise<string | null> {
    try {
      const { stdout } = await git(workspace, this.config, ['rev-parse', 'HEAD']);
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /** Rolls the workspace back to a known commit — used to undo a merge that broke the tests. */
  async resetHard(workspace: string, sha: string): Promise<void> {
    await git(workspace, this.config, ['reset', '--hard', sha]);
  }

  async hasNewCommitSince(workspace: string, sha: string | null): Promise<boolean> {
    const head = await this.headSha(workspace);
    return head !== null && head !== sha;
  }
}
