import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { GithubStatusDto } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';
import type { ProjectRow } from '../db/repos/index.js';
import { badRequest, conflict } from '../core/httpError.js';
import { commonSystemPrompt } from '../prompts/common.js';
import { recordUsage } from '../core/usageTracker.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { verifyStack } from '../pipeline/verify.js';
import { slugify } from '../pipeline/workspace.js';
import { importAnalysisPrompt } from '../prompts/steps.js';
import { IMPORT_JSON_SCHEMA, ImportOutputZ, extractStructured } from '../prompts/schemas.js';
import { ZERO_USAGE } from '../claude/types.js';
import { downloadIssueAssets, extractAttachmentUrls, type AssetResult } from './issueAssets.js';

const execFileP = promisify(execFile);

const STATUS_CACHE_MS = 5 * 60_000;
/** No workspace mutation is allowed while a session works in it. */
const BUSY_STATUSES = ['building', 'deploying'];

export interface RemoteRepo {
  name: string;
  nameWithOwner: string;
  visibility: string;
  isPrivate: boolean;
  updatedAt: string;
  url: string;
}

export interface SyncState {
  ahead: number | null;
  behind: number | null;
}

/** Aggregate GitHub Actions state of one commit ('none' = no run registered). */
export type CiState = 'none' | 'pending' | 'success' | 'failure';

/** Verdict for a set of workflow runs. Pure — unit-tested. */
export function ciStateOf(runs: { status: string; conclusion: string }[]): CiState {
  if (!runs.length) return 'none';
  if (runs.some((r) => r.status !== 'completed')) return 'pending';
  return runs.every((r) => ['success', 'skipped', 'neutral'].includes(r.conclusion)) ? 'success' : 'failure';
}

/**
 * Git credential helper for github.com, injected through the environment
 * (GIT_CONFIG_COUNT/KEY_n/VALUE_n, appended after any pair already set) —
 * equivalent to `gh auth setup-git`, but without depending on a ~/.gitconfig
 * that does not survive a container rebuild. Without it every https push/fetch
 * fails with "could not read Username for 'https://github.com'" while gh API
 * calls keep working. The empty first value resets inherited helpers. Pure — unit-tested.
 */
export function ghCredentialEnv(ghBin: string, base: NodeJS.ProcessEnv): Record<string, string> {
  const start = Number(base.GIT_CONFIG_COUNT) || 0;
  const key = 'credential.https://github.com.helper';
  const quoted = `'${ghBin.replace(/'/g, `'\\''`)}'`;
  return {
    GIT_CONFIG_COUNT: String(start + 2),
    [`GIT_CONFIG_KEY_${start}`]: key,
    [`GIT_CONFIG_VALUE_${start}`]: '',
    [`GIT_CONFIG_KEY_${start + 1}`]: key,
    [`GIT_CONFIG_VALUE_${start + 1}`]: `!${quoted} auth git-credential`,
  };
}

/**
 * GitHub integration via the `gh` CLI. pj-gen never touches a token: gh keeps
 * its own keyring; git identity (UsrRed) is forced through the env on every call.
 */
export class GithubService {
  private statusCache: { at: number; value: GithubStatusDto } | null = null;

  constructor(private deps: CoreDeps) {}

  private gitEnv(): NodeJS.ProcessEnv {
    const { config } = this.deps;
    return {
      ...process.env,
      ...ghCredentialEnv(config.ghBin, process.env),
      GIT_AUTHOR_NAME: config.gitAuthorName,
      GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
      GIT_COMMITTER_NAME: config.gitAuthorName,
      GIT_COMMITTER_EMAIL: config.gitAuthorEmail,
    };
  }

  private async gh(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    const { stdout } = await execFileP(this.deps.config.ghBin, args, {
      cwd: opts.cwd,
      env: this.gitEnv(),
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  }

  private async git(cwd: string, args: string[], timeoutMs = 20_000): Promise<string> {
    const { stdout } = await execFileP('git', args, { cwd, env: this.gitEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }

  private httpsProtocolEnsured = false;
  /**
   * gh defaults to the ssh git protocol (set in ~/.config/gh/hosts.yml at
   * `gh auth login` time, overriding the global config even if that one is
   * https) — this image has no ssh client, so any git-network gh call
   * (clone, `repo create --push`) fails with "cannot run ssh: No such file
   * or directory" while pure API calls (status, listRemoteRepos) keep
   * working fine, since only those go over ssh. Force https at both scopes;
   * memoized since it only needs to happen once per process.
   */
  private async ensureHttpsProtocol(): Promise<void> {
    if (this.httpsProtocolEnsured) return;
    this.httpsProtocolEnsured = true;
    try {
      await this.gh(['config', 'set', 'git_protocol', 'https']);
      await this.gh(['config', 'set', '-h', 'github.com', 'git_protocol', 'https']);
    } catch {
      /* best-effort — a real auth/gh problem surfaces at the call site anyway */
    }
  }

  async status(force = false): Promise<GithubStatusDto> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.value;
    let value: GithubStatusDto;
    try {
      await this.gh(['auth', 'status'], { timeoutMs: 15_000 });
      let login: string | null = null;
      try {
        login = (await this.gh(['api', 'user', '--jq', '.login'], { timeoutMs: 15_000 })).trim() || null;
      } catch {
        /* auth ok but api failed — keep login null */
      }
      value = { installed: true, authOk: true, login, detail: '' };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string };
      value =
        e.code === 'ENOENT'
          ? { installed: false, authOk: false, login: null, detail: 'gh introuvable — installe le GitHub CLI' }
          : { installed: true, authOk: false, login: null, detail: (e.stderr || e.message || '').slice(0, 300) };
    }
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  async listRemoteRepos(): Promise<RemoteRepo[]> {
    const out = await this.gh(['repo', 'list', '--limit', '100', '--json', 'name,nameWithOwner,visibility,isPrivate,updatedAt,url']);
    return JSON.parse(out) as RemoteRepo[];
  }

  /** Publish a project's workspace as a new GitHub repo (private by default) and push. */
  async linkProject(projectId: string, opts: { private?: boolean } = {}): Promise<ProjectRow> {
    const { repos, ws, mutex } = this.deps;
    return mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (project.github_repo) throw conflict(`Déjà publié: ${project.github_repo}`);
      if (BUSY_STATUSES.includes(project.status)) throw conflict(`Publication impossible en statut « ${project.status} »`);
      const isPrivate = opts.private ?? repos.settings.getAll().githubDefaultPrivate;

      // Sweep uncommitted artifacts first (safe: no session is working in this workspace).
      await ws.commitAll(project.workspace_path, 'chore: pre-publish');
      await this.ensureHttpsProtocol();
      const out = await this.gh(
        ['repo', 'create', project.slug, isPrivate ? '--private' : '--public', '--source', '.', '--push'],
        { cwd: project.workspace_path, timeoutMs: 120_000 }
      );
      const m = out.match(/github\.com\/([\w.-]+\/[\w.-]+)/);
      const login = (await this.status()).login;
      const repoFullName = m ? m[1].replace(/\.git$/, '') : `${login ?? '?'}/${project.slug}`;
      const sha = await ws.headSha(project.workspace_path);
      repos.projects.patch(projectId, {
        github_repo: repoFullName,
        github_private: isPrivate ? 1 : 0,
        github_last_push_sha: sha,
        github_last_push_at: Date.now(),
      });
      this.emitProject(projectId);
      return repos.projects.byId(projectId)!;
    }).then((row) => {
      this.triggerPendingCi(projectId);
      return row;
    });
  }

  /** Optional commit (custom message) + push origin main; refuses while a session owns the workspace. */
  async push(projectId: string, message?: string, opts: { autoResolve?: boolean } = {}): Promise<ProjectRow> {
    const { repos, ws, mutex } = this.deps;
    return mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (!project.github_repo) throw conflict('Projet non publié sur GitHub');
      if (BUSY_STATUSES.includes(project.status)) throw conflict(`Push impossible en statut « ${project.status} »`);
      if (message?.trim()) await ws.commitAll(project.workspace_path, message.trim());
      await this.pushWithRetry(projectId, project.workspace_path, opts);
      const sha = await ws.headSha(project.workspace_path);
      repos.projects.patch(projectId, { github_last_push_sha: sha, github_last_push_at: Date.now() });
      this.emitProject(projectId);
      return repos.projects.byId(projectId)!;
    });
  }

  /**
   * True when a `git push` failure is a plain non-fast-forward rejection (remote has commits
   * we don't) — git reports this as "(non-fast-forward)" once our remote-tracking ref is known
   * stale, or "(fetch first)" when we never fetched at all. Same underlying cause, same fix.
   */
  private isNonFastForward(err: unknown): boolean {
    const stderr = (err as { stderr?: string } | undefined)?.stderr ?? '';
    if (!stderr.includes('[rejected]')) return false;
    return (
      stderr.includes('non-fast-forward') ||
      stderr.includes('fetch first') ||
      stderr.includes('Updates were rejected because the tip of your current branch is behind')
    );
  }

  /**
   * `git push origin HEAD`; on a non-fast-forward rejection (the local branch drifted behind
   * origin — e.g. a manual push, or a previous auto-push whose commit got amended upstream),
   * fetch + merge the remote branch once and retry. A merge conflict aborts cleanly and
   * surfaces a plain French HttpError instead of retrying forever with the same push error —
   * `IssuePoller.finalizeFixing` calls this on every tick, and a silent infinite retry there
   * leaves the originating GitHub issue stuck in "fixing" and blocks every issue queued behind it.
   * `opts.autoResolve` (auto-issue flow only, never the manual push button) attempts a further
   * recovery via `attemptAutoMergeResolution` before giving up.
   */
  private async pushWithRetry(projectId: string, cwd: string, opts: { autoResolve?: boolean } = {}): Promise<void> {
    // HEAD instead of a hardcoded branch: imported repos may live on master or another default.
    try {
      await this.git(cwd, ['push', 'origin', 'HEAD'], 60_000);
    } catch (err) {
      if (!this.isNonFastForward(err)) throw err;
      const branch = (await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
      await this.git(cwd, ['fetch', 'origin'], 30_000);
      try {
        await this.git(cwd, ['merge', '--no-edit', `origin/${branch}`], 30_000);
      } catch {
        await this.git(cwd, ['merge', '--abort']).catch(() => undefined);
        if (opts.autoResolve) {
          await this.attemptAutoMergeResolution(projectId, cwd, branch);
          return;
        }
        const detail = 'Le dépôt distant a des changements en conflit avec le workspace local — résolution manuelle nécessaire.';
        this.deps.bus.emitTransient('app.log', projectId, { lines: [`[github push] ${detail}`] });
        throw conflict(detail);
      }
      await this.git(cwd, ['push', 'origin', 'HEAD'], 60_000);
    }
  }

  /**
   * Last-resort recovery for a genuine merge conflict, used only by the auto-issue flow
   * (`IssuePoller.finalizeFixing`, itself gated to private repos with auto-mode on). Saves the
   * local work to a throwaway branch on GitHub first (never lost, whatever happens next), then
   * tries to resolve the conflict with a tool-using Claude session on that branch, verifies the
   * result (install+build+test) before ever touching `<branch>`, and only fast-forwards/pushes
   * `<branch>` when the resolved merge is proven to build and pass tests. Any failure along the
   * way leaves `<branch>` untouched locally and rethrows a conflict() naming the recovery branch,
   * which `finalizeFixing` already surfaces verbatim in its GitHub comment.
   */
  private async attemptAutoMergeResolution(projectId: string, cwd: string, branch: string): Promise<void> {
    const { repos, runner, config, bus } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project) throw conflict('Projet introuvable');
    const recoveryBranch = `auto/${branch}-conflict-${Date.now()}`;
    try {
      // Unconditional save point: whatever happens below, this local work now exists on GitHub.
      await this.git(cwd, ['push', 'origin', `HEAD:refs/heads/${recoveryBranch}`], 60_000);
      await this.git(cwd, ['checkout', '-b', recoveryBranch]);
      bus.emitTransient('app.log', projectId, {
        lines: [`[github push] conflit réel — travail sauvegardé sur \`${recoveryBranch}\`, tentative de résolution automatique`],
      });

      await this.git(cwd, ['merge', '--no-edit', `origin/${branch}`], 30_000).catch(() => undefined);
      if (fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) {
        const sessionId = randomUUID();
        repos.sessions.insert(sessionId, projectId, 'merge_resolve');
        const { model, fallbackModel } = resolveModel(repos, project, 'merge_resolve');
        const caps = capsFor(repos, 'merge_resolve');
        const settings = repos.settings.getAll();
        const handle = runner({
          cwd,
          prompt: [
            `Un merge git est en cours dans ce dépôt (fusion de origin/${branch} dans ${recoveryBranch}) et contient des conflits.`,
            'Exécute `git status` pour lister les fichiers en conflit, résous CHAQUE conflit en préservant l’intention des deux côtés (ne supprime aucune fonctionnalité existante des deux historiques, n’en ajoute aucune nouvelle), puis termine par `git add -A && git commit --no-edit` pour clore le merge.',
            'Si un conflit est réellement irréconciliable, explique pourquoi dans ta réponse finale sans faire de commit partiel.',
          ].join('\n'),
          sessionId,
          resume: false,
          model,
          fallbackModel,
          tools: 'default',
          appendSystemPrompt: commonSystemPrompt(),
          maxBudgetUsd: settings.maxBudgetUsdPerSession,
          maxTurns: caps.maxTurns,
          timeoutMs: caps.timeoutMs,
        });
        const result = await handle.result;
        repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
        if (recordUsage(repos, projectId, 'merge_resolve', result)) this.deps.sched.emitQuota();
        repos.sessions.setStatus(sessionId, 'closed');
      }
      if (fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) {
        throw new Error('la session n’a pas terminé la résolution du conflit');
      }

      const stack = repos.projects.stackOf(project);
      const verify = await verifyStack(config, cwd, stack, ['install', 'build', 'test'], { forceInstall: true });
      if (!verify.ok) throw new Error(`vérification post-merge en échec (${verify.label}) : ${verify.tail.slice(0, 300)}`);

      await this.git(cwd, ['push', 'origin', `HEAD:refs/heads/${recoveryBranch}`], 60_000);
      await this.git(cwd, ['checkout', branch]);
      await this.git(cwd, ['merge', '--ff-only', recoveryBranch]);
      await this.git(cwd, ['push', 'origin', `HEAD:${branch}`], 60_000);
    } catch (err) {
      await this.git(cwd, ['merge', '--abort']).catch(() => undefined);
      await this.git(cwd, ['checkout', branch]).catch(() => undefined);
      const msg = err instanceof Error ? err.message : String(err);
      throw conflict(
        `Le dépôt distant a des changements en conflit avec le workspace local — résolution automatique tentée sans succès (${msg}). Le travail local a été sauvegardé sur la branche \`${recoveryBranch}\` sur GitHub pour revue manuelle.`
      );
    }
  }

  /**
   * Brings a workspace that fell behind its GitHub remote up to date (commits pushed straight to the
   * repo, outside pj-gen): fast-forward when it has nothing of its own, a merge commit when both
   * sides moved. Never touches a workspace a session may be working in, nor one with uncommitted
   * changes, and a real conflict aborts cleanly (the workspace is left exactly as it was).
   */
  async pullIfBehind(projectId: string): Promise<'uptodate' | 'fast-forward' | 'merged' | 'skipped' | 'conflict'> {
    const { repos, mutex, bus } = this.deps;
    return mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project?.github_repo || BUSY_STATUSES.includes(project.status)) return 'skipped';
      const cwd = project.workspace_path;
      const log = (line: string) => bus.emitTransient('app.log', projectId, { lines: [`[github sync] ${line}`] });
      try {
        const branch = (await this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        if (!branch || branch === 'HEAD') return 'skipped'; // detached or recovery state: not ours to move
        if (fs.existsSync(path.join(cwd, '.git', 'MERGE_HEAD'))) return 'skipped';
        const sync = await this.syncState(project);
        if (!sync.behind) return 'uptodate'; // null = fetch failed, 0 = nothing to take
        if ((await this.git(cwd, ['status', '--porcelain'])).trim()) {
          log(`${sync.behind} commit(s) en retard mais le workspace a des changements non commités : synchronisation reportée`);
          return 'skipped';
        }
        if (!sync.ahead) {
          await this.git(cwd, ['merge', '--ff-only', `origin/${branch}`], 30_000);
          log(`${sync.behind} commit(s) récupéré(s) depuis origin/${branch} (fast-forward)`);
          this.emitProject(projectId);
          return 'fast-forward';
        }
        try {
          await this.git(cwd, ['merge', '--no-edit', `origin/${branch}`], 30_000);
        } catch {
          await this.git(cwd, ['merge', '--abort']).catch(() => undefined);
          log(`conflit entre ${sync.ahead} commit(s) locaux et ${sync.behind} commit(s) distants : résolution manuelle nécessaire, workspace inchangé`);
          return 'conflict';
        }
        log(`origin/${branch} fusionné (${sync.behind} commit(s) distants, ${sync.ahead} locaux)`);
        this.emitProject(projectId);
        return 'merged';
      } catch (err) {
        log(`échec : ${(err as Error).message?.slice(0, 200)}`);
        return 'skipped';
      }
    });
  }

  /** ahead/behind vs the current branch's remote counterpart (best-effort: null on fetch failure). */
  async syncState(project: ProjectRow): Promise<SyncState> {
    try {
      await this.git(project.workspace_path, ['fetch', 'origin', '--quiet'], 20_000);
      const branch = (await this.git(project.workspace_path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
      const out = await this.git(project.workspace_path, ['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`]);
      const [behind, ahead] = out.trim().split(/\s+/).map(Number);
      return { ahead: Number.isFinite(ahead) ? ahead : null, behind: Number.isFinite(behind) ? behind : null };
    } catch {
      return { ahead: null, behind: null };
    }
  }

  /** Auto-issue mode: allowed on PRIVATE repos only (untrusted public content never auto-runs). */
  setAutoMode(projectId: string, enabled: boolean): ProjectRow {
    const { repos } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project) throw badRequest('Projet introuvable');
    if (!project.github_repo) throw conflict('Projet non publié sur GitHub');
    if (enabled && project.github_private !== 1) throw badRequest('Le mode auto est réservé aux dépôts privés');
    repos.projects.patch(projectId, { github_auto_mode: enabled ? 1 : 0 });
    this.emitProject(projectId);
    this.triggerPendingCi(projectId);
    return repos.projects.byId(projectId)!;
  }

  /**
   * Request .github/workflows/ci.yml. Without a linked repo there is nothing to push to yet:
   * the request is persisted (`github_ci_pending`) and returned as 'queued' instead of failing —
   * `triggerPendingCi` fires it automatically once linkProject/setAutoMode make a repo available.
   */
  async generateCi(projectId: string): Promise<{ status: 'queued' | 'generated' }> {
    const { repos } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project) throw badRequest('Projet introuvable');
    if (!project.github_repo) {
      if (project.github_ci_pending !== 1) {
        repos.projects.patch(projectId, { github_ci_pending: 1 });
        this.emitProject(projectId);
      }
      return { status: 'queued' };
    }
    await this.runCiGeneration(projectId);
    return { status: 'generated' };
  }

  /** Fires a queued generate-ci request once a repo is available. Best-effort: a failure is
   *  logged, not surfaced — the project stays usable and a manual generate-ci call can retry. */
  private triggerPendingCi(projectId: string): void {
    const { repos } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project || !project.github_repo || project.github_ci_pending !== 1) return;
    repos.projects.patch(projectId, { github_ci_pending: 0 });
    this.emitProject(projectId);
    void this.runCiGeneration(projectId).catch((err) => {
      console.error(`[github] échec de la génération CI automatique pour ${projectId}:`, err);
    });
  }

  /** Small claude session writing .github/workflows/ci.yml, then push. */
  private async runCiGeneration(projectId: string): Promise<void> {
    const { repos, ws, runner, mutex } = this.deps;
    await mutex.run(projectId, async () => {
      const project = repos.projects.byId(projectId);
      if (!project) throw badRequest('Projet introuvable');
      if (!project.github_repo) throw conflict('Projet non publié sur GitHub');
      if (BUSY_STATUSES.includes(project.status)) throw conflict(`Génération CI impossible en statut « ${project.status} »`);
      const stack = repos.projects.stackOf(project);

      const sessionId = randomUUID();
      repos.sessions.insert(sessionId, projectId, 'ci');
      const { model, fallbackModel } = resolveModel(repos, project, 'ci');
      const caps = capsFor(repos, 'ci');
      const settings = repos.settings.getAll();
      const handle = runner({
        cwd: project.workspace_path,
        prompt: [
          'Écris un workflow GitHub Actions de test complet dans .github/workflows/ci.yml.',
          '- Déclencheurs: push sur main + pull_request.',
          `- Étapes: checkout, installation (« ${stack?.install_cmd || 'détecte-la depuis docs/ARCHITECTURE.md'} »), build (« ${stack?.build_cmd || 'si applicable'} »), tests (« ${stack?.test_cmd || 'détecte-la'} »).`,
          '- Runtime et versions: déduis-les de docs/ARCHITECTURE.md et des fichiers de config du projet.',
          "- Termine par: git add .github && git commit -m \"ci: add test workflow\".",
        ].join('\n'),
        sessionId,
        resume: false,
        model,
        fallbackModel,
        tools: 'default',
        appendSystemPrompt: commonSystemPrompt(),
        maxBudgetUsd: settings.maxBudgetUsdPerSession,
        maxTurns: caps.maxTurns,
        timeoutMs: caps.timeoutMs,
      });
      const result = await handle.result;
      repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
      if (recordUsage(repos, projectId, 'ci', result)) this.deps.sched.emitQuota();
      repos.sessions.setStatus(sessionId, 'closed');
      if (result.outcome !== 'success') throw conflict(`Génération CI échouée: ${result.failure?.message ?? 'erreur inconnue'}`);
      if (!ws.readFile(project.workspace_path, '.github/workflows/ci.yml')) {
        throw conflict('La session n’a pas produit .github/workflows/ci.yml');
      }
      await ws.commitAll(project.workspace_path, 'ci: add test workflow');
    });
    // autoResolve: true — same recovery path as the auto-issue flow (attemptAutoMergeResolution):
    // generate-ci runs unattended (manual button or auto-fire on link), so a genuine merge
    // conflict must not just surface a "résolution manuelle nécessaire" error with no retry path.
    await this.push(projectId, undefined, { autoResolve: true });
  }

  /**
   * Clone a remote repo into the workspace root and register it as a pj-gen
   * project (status deployed → micro-modifications and improvement iterations
   * work). The reference docs (SPEC/ARCHITECTURE/INTERFACES) and the stack are
   * reconstructed asynchronously by an adoption session.
   */
  async cloneRepo(nameWithOwner: string): Promise<ProjectRow> {
    const { repos, ws, config, bus } = this.deps;
    const status = await this.status();
    if (!status.authOk) throw conflict('GitHub CLI non connecté');
    if (!/^[\w.-]+\/[\w.-]+$/.test(nameWithOwner)) throw badRequest('Nom de dépôt invalide (attendu: owner/name)');
    if (repos.projects.all().some((p) => p.github_repo === nameWithOwner)) throw conflict('Dépôt déjà cloné');
    await this.ensureHttpsProtocol();

    const repoName = nameWithOwner.split('/')[1];
    let slug = slugify(repoName);
    if (repos.projects.slugExists(slug) || ws.exists(slug)) {
      for (let i = 2; i < 100; i++) {
        const candidate = `${slug.slice(0, 30)}-${i}`;
        if (!repos.projects.slugExists(candidate) && !ws.exists(candidate)) {
          slug = candidate;
          break;
        }
      }
    }
    fs.mkdirSync(config.workspaceRoot, { recursive: true });
    await this.gh(['repo', 'clone', nameWithOwner, ws.pathFor(slug)], { timeoutMs: 180_000 });
    const workspacePath = await ws.adoptClone(slug, repoName);

    const id = randomUUID();
    repos.projects.insert({ id, slug, title: repoName, model: null, workspacePath, initialPrompt: `Projet importé depuis GitHub (${nameWithOwner}).` });
    // An imported repo is an already-built product: deployed = reopenable + micro-able.
    repos.projects.casStatus(id, ['draft'], 'deployed');
    let isPrivate: number | null = null;
    try {
      const view = JSON.parse(await this.gh(['repo', 'view', nameWithOwner, '--json', 'isPrivate'], { timeoutMs: 15_000 })) as { isPrivate?: boolean };
      if (typeof view.isPrivate === 'boolean') isPrivate = view.isPrivate ? 1 : 0;
    } catch {
      /* visibility unknown — auto-mode stays locked until known private */
    }
    const sha = await ws.headSha(workspacePath);
    repos.projects.patch(id, {
      github_repo: nameWithOwner,
      github_private: isPrivate,
      github_last_push_sha: sha,
      github_last_push_at: Date.now(),
    });
    this.emitProject(id);
    bus.emit('queue.updated', null, repos.projects.queueSnapshot());
    void this.analyzeImport(id).catch(() => undefined);
    return repos.projects.byId(id)!;
  }

  /**
   * Re-runs the adoption analysis of an imported project whose first one failed (stack still
   * null). Returns whether the stack is now known — the micro pipeline cannot run without it.
   */
  async reanalyzeImport(projectId: string): Promise<boolean> {
    await this.analyzeImport(projectId);
    return !!this.deps.repos.projects.byId(projectId)?.stack;
  }

  /** Adoption session: reverse-engineer SPEC/ARCHITECTURE/INTERFACES + stack from the cloned code. */
  private async analyzeImport(projectId: string): Promise<void> {
    const { repos, ws, runner, bus } = this.deps;
    const project = repos.projects.byId(projectId);
    if (!project) return;
    const warn = (msg: string) => {
      ws.appendProgress(project.workspace_path, `analyse d'import échouée: ${msg.slice(0, 300)}`);
      bus.emit('boot.notice', null, { level: 'warn', message: `Import ${project.slug}: analyse échouée (${msg.slice(0, 120)})` });
    };

    const sessionId = randomUUID();
    repos.sessions.insert(sessionId, projectId, 'import');
    const { model, fallbackModel } = resolveModel(repos, project, 'import');
    const caps = capsFor(repos, 'import');
    const settings = repos.settings.getAll();
    const handle = runner({
      cwd: project.workspace_path,
      prompt: importAnalysisPrompt(project.github_repo ?? project.slug),
      sessionId,
      resume: false,
      model,
      fallbackModel,
      tools: 'default',
      jsonSchema: IMPORT_JSON_SCHEMA,
      appendSystemPrompt: commonSystemPrompt(),
      maxBudgetUsd: settings.maxBudgetUsdPerSession,
      maxTurns: caps.maxTurns,
      timeoutMs: caps.timeoutMs,
    });
    const result = await handle.result;
    repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
    if (recordUsage(repos, projectId, 'import', result)) this.deps.sched.emitQuota();
    repos.sessions.setStatus(sessionId, 'closed');
    if (result.outcome !== 'success') return warn(result.failure?.message ?? 'session en échec');
    const parsed = extractStructured(ImportOutputZ, result.structured, result.resultText);
    if (!parsed.ok) return warn(`sortie invalide: ${parsed.error}`);

    const d = parsed.data;
    if (!ws.readFile(project.workspace_path, 'docs/SPEC.md')) ws.writeFile(project.workspace_path, 'docs/SPEC.md', d.spec_markdown);
    if (!ws.readFile(project.workspace_path, 'docs/ARCHITECTURE.md')) ws.writeFile(project.workspace_path, 'docs/ARCHITECTURE.md', d.architecture_markdown);
    const interfaces = d.interfaces_markdown ?? '';
    if (interfaces.trim() && !ws.readFile(project.workspace_path, 'docs/INTERFACES.md')) {
      ws.writeFile(project.workspace_path, 'docs/INTERFACES.md', interfaces);
    }
    repos.projects.patch(projectId, { stack: JSON.stringify(d.stack) });
    // Synthetic succeeded scaffold run: the workspace IS scaffolded — a future
    // improvement iteration must skip the scaffold step (hasSucceeded check).
    const run = repos.stepRuns.create(projectId, 'scaffold', null, 1, sessionId, model);
    repos.stepRuns.finish(run.id, { status: 'succeeded', numTurns: 0, costUsd: 0, usage: ZERO_USAGE });
    await ws.commitAll(project.workspace_path, 'docs: adopt existing repository');
    ws.appendProgress(project.workspace_path, 'analyse d’import terminée — SPEC/ARCHITECTURE reconstruites, stack détectée');
    bus.emit('artifact.updated', projectId, { path: 'docs/SPEC.md' });
    this.emitProject(projectId);
  }

  /** GitHub Actions state of a commit (every workflow run on that SHA, aggregated). */
  async ciStatus(repo: string, sha: string): Promise<CiState> {
    const out = await this.gh(['run', 'list', '-R', repo, '--commit', sha, '--json', 'status,conclusion', '--limit', '50']);
    return ciStateOf(JSON.parse(out || '[]') as { status: string; conclusion: string }[]);
  }

  /** Post a comment on an issue (used by the auto-issue fixer). */
  async issueComment(repo: string, issueNumber: number, body: string): Promise<void> {
    await this.gh(['issue', 'comment', String(issueNumber), '-R', repo, '--body', body]);
  }

  async issueClose(repo: string, issueNumber: number): Promise<void> {
    await this.gh(['issue', 'close', String(issueNumber), '-R', repo]);
  }

  async listIssues(repo: string): Promise<{ number: number; title: string; body: string; author: { login: string }; updatedAt: string }[]> {
    const out = await this.gh(['issue', 'list', '-R', repo, '--state', 'open', '--json', 'number,title,body,author,updatedAt']);
    return JSON.parse(out) as { number: number; title: string; body: string; author: { login: string }; updatedAt: string }[];
  }

  async issueComments(repo: string, issueNumber: number): Promise<{ author: { login: string }; createdAt: string; body: string }[]> {
    const out = await this.gh(['issue', 'view', String(issueNumber), '-R', repo, '--json', 'comments', '--jq', '.comments']);
    return JSON.parse(out || '[]') as { author: { login: string }; createdAt: string; body: string }[];
  }

  /** gh keyring token, needed to fetch private-repo attachments over HTTPS. */
  private async authToken(): Promise<string | null> {
    try {
      return (await this.gh(['auth', 'token'], { timeoutMs: 10_000 })).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Download the attachments referenced in an issue body (screenshots, files…)
   * under <dataDir>/issue-assets/<projectId>/<issueNumber>/. Failures are
   * per-file and non-fatal: the fix flow degrades to text-only context.
   */
  async downloadIssueAttachments(projectId: string, issueNumber: number, body: string): Promise<AssetResult[]> {
    const urls = extractAttachmentUrls(body);
    if (!urls.length) return [];
    const destDir = path.join(this.deps.config.dataDir, 'issue-assets', projectId, String(issueNumber));
    return downloadIssueAssets(urls, destDir, await this.authToken());
  }

  private emitProject(projectId: string): void {
    const row = this.deps.repos.projects.byId(projectId);
    if (row) this.deps.bus.emit('project.updated', projectId, { project: this.deps.repos.projects.summary(row) });
  }
}
