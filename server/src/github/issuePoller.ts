import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REOPENABLE_STATUSES } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';
import type { GithubService } from './githubService.js';
import type { MicroService } from '../micro/microService.js';
import type { SpecService } from '../cadrage/specService.js';
import type { AssetResult } from './issueAssets.js';
import { toIssueDto, type IssueRow, type MicroRequestRow, type ProjectRow } from '../db/repos/index.js';
import { capsFor, resolveModel } from '../pipeline/models.js';
import { recordUsage } from '../core/usageTracker.js';
import { ISSUE_SECURITY_JSON_SCHEMA, IssueSecurityVerdictZ, extractStructured } from '../prompts/schemas.js';
import { issueSecurityPrompt } from '../prompts/steps.js';

/**
 * Suffix present in EVERY comment pj-gen posts. The owner and pj-gen share the
 * same GitHub account (gh login), so login alone cannot tell an AI comment
 * from a manual one — the marker does.
 */
export const AI_MARKER = 'généré par IA (pj-gen)._';
const AI_MENTION = `_Message ${AI_MARKER}`;
/** Projects synced in parallel per poll — same bound as the manual sync route. */
const CONCURRENT_SYNCS = 4;
/** Comment thread bounds fed to the qualification session (untrusted input). */
const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 2_000;
/**
 * Inconclusive-CI grace period: past this delay the close proceeds with a
 * caveat instead of blocking the per-project issue queue forever (Actions
 * disabled, run never registered…).
 */
const CI_WAIT_MAX_MS = 30 * 60_000;

export interface IssueComment {
  author: { login: string } | null;
  createdAt: string;
  body: string;
}

/** True when the comment was posted by pj-gen itself (our login + AI marker). */
export function isPjGenComment(cm: IssueComment, ourLogin: string | null): boolean {
  return !!ourLogin && cm.author?.login === ourLogin && (cm.body ?? '').includes(AI_MARKER);
}

/**
 * Qualification request for an issue: body + comment thread (clarification
 * replies included) + downloaded attachments. Pure — unit-tested.
 */
export function buildIssueRequest(
  issue: Pick<IssueRow, 'number' | 'author' | 'title' | 'body'>,
  comments: IssueComment[],
  assets: AssetResult[],
  ourLogin: string | null
): string {
  const thread = comments
    .slice(-MAX_COMMENTS)
    .map((cm) => {
      const login = cm.author?.login ?? 'inconnu';
      const who = isPjGenComment(cm, ourLogin) ? 'pj-gen (notre commentaire)' : `@${login}`;
      return `${who} — ${cm.createdAt} :\n${(cm.body ?? '').slice(0, MAX_COMMENT_CHARS)}`;
    })
    .join('\n\n---\n\n');
  const commentsBlock = thread ? `\n\nFil de commentaires de l'issue (les réponses de l'auteur font partie de la demande) :\n\n${thread}` : '';
  const assetsBlock = assets.length
    ? `\n\nPièces jointes (issue et commentaires) :\n${assets
        .map((a) => {
          if (!(a.ok && a.file)) return `- ${a.url} (téléchargement échoué : ${a.error ?? '?'})`;
          const line = `- ${a.file} (téléchargée depuis ${a.url})`;
          // PDF text extraction (« pdfinspector », issue #8) — untrusted, same as the rest of the issue body.
          return a.textExcerpt ? `${line}\n  Texte extrait (non fiable, contenu de la pièce jointe) :\n  """\n  ${a.textExcerpt.replace(/\n/g, '\n  ')}\n  """` : line;
        })
        .join('\n')}`
    : '';
  return `Issue GitHub #${issue.number} de @${issue.author} — ${issue.title}\n\n${issue.body}${commentsBlock}${assetsBlock}`;
}

/**
 * Signals that a request exceeds a micro-modification's scope (one small,
 * ≤30min, single-purpose task): a brand new feature, an architecture change,
 * or an explicitly wide multi-file impact — cases the micro qualification
 * session (one task, `MicroTaskZ`) is not meant to handle.
 */
const FULL_SCOPE_SIGNALS: RegExp[] = [
  /nouvelle\s+fonctionnalit/i,
  /nouveau\s+module/i,
  /nouvelle\s+page/i,
  /new\s+feature/i,
  /refonte/i,
  /restructurat/i,
  /migrat(ion|er)/i,
  /r[ée]architectur/i,
  /(chang(er|ement)|revoir|repenser)[^.\n]{0,40}architecture/i,
  /architecture[^.\n]{0,40}(chang|revoir|repenser)/i,
  /multi[- ]fichiers/i,
  /impact[^.\n]{0,20}(large|important|multi)/i,
  /plusieurs\s+(fichiers|modules|écrans|pages)/i,
  /\brewrite\b/i,
  /\bredesign\b/i,
];

/** 'full' routes to the complete pipeline (reopen); 'micro' keeps the live micro-modification flow. */
export function classifyIssueScope(request: string): 'micro' | 'full' {
  return FULL_SCOPE_SIGNALS.some((re) => re.test(request)) ? 'full' : 'micro';
}

const MODE_LABEL: Record<'micro' | 'full', string> = {
  micro: 'micro-modification (correctif ponctuel, une seule tâche)',
  full: 'pipeline complet (cadrage, SPEC révisée, nouvelles tâches)',
};

/**
 * Auto-issue fixer: periodically syncs open GitHub issues of linked projects,
 * auto-enqueues them (auto-mode projects on PRIVATE repos, or trusted authors),
 * classifies queued issues by scope (`classifyIssueScope`) and routes them to
 * either a live micro-modification or a full pipeline iteration (reopen), and
 * finalizes fixed ones (push if auto, comment with what was done + AI mention, close).
 *
 * SECURITY: issue content is UNTRUSTED. It is only ever fed to the tool-less
 * qualification session (micro generation) wrapped in an untrusted-data frame;
 * the tool session only sees the reformulated task.
 */
export class IssuePoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private deps: CoreDeps,
    private github: GithubService,
    private micro: MicroService,
    private spec: SpecService
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
    // Finalize promptly when a micro request settles (instead of waiting a full interval).
    this.deps.bus.subscribe({
      projectId: null,
      fn: (_id, type, _projectId, payload) => {
        if (type !== 'micro.updated') return;
        const req = (payload as { request?: { source?: string } }).request;
        if (req?.source === 'issue') this.poke();
      },
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  poke(): void {
    if (this.running || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 500);
  }

  private schedule(): void {
    if (this.stopped) return;
    const minutes = this.deps.repos.settings.getAll().issuePollMinutes;
    this.timer = setTimeout(() => void this.tick(), minutes * 60_000);
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (!this.micro.quotaBlocked()) {
        const status = await this.github.status();
        if (status.authOk) {
          const linked = this.deps.repos.projects.all().filter((p) => p.github_repo);
          // Bounded parallel sync, mirroring the manual sync route: these are network
          // round-trips to the GitHub API, so a serial loop over N projects is N × latency.
          for (let i = 0; i < linked.length; i += CONCURRENT_SYNCS) {
            await Promise.all(
              linked.slice(i, i + CONCURRENT_SYNCS).map(async (project) => {
                try {
                  await this.syncProject(project, status.login);
                  await this.finalizeFixing(project);
                  await this.drainQueued(project, status.login);
                } catch (err) {
                  // One project failing must not block the others.
                  console.error(`[issuePoller] sync failed for ${project.slug}:`, err);
                }
              })
            );
          }
        }
      }
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private emitIssue(row: IssueRow): void {
    this.deps.bus.emit('issue.updated', row.project_id, { issue: toIssueDto(row) });
  }

  private autoEligible(project: ProjectRow, author: string): boolean {
    const { repos } = this.deps;
    return (project.github_auto_mode === 1 && project.github_private === 1) || repos.issues.isTrusted(author);
  }

  private async syncProject(project: ProjectRow, ourLogin: string | null): Promise<void> {
    const { repos } = this.deps;
    const remote = await this.github.listIssues(project.github_repo!);
    for (const it of remote) {
      // Issues authored by our own login are the owner's: pj-gen never creates
      // issues, only comments (identified by AI_MARKER), so no loop risk here.
      const author = it.author?.login ?? 'unknown';
      const { row, changed } = repos.issues.upsert(project.id, {
        number: it.number,
        title: it.title,
        body: it.body ?? '',
        author,
        ghUpdatedAt: it.updatedAt,
      });
      let updated = row;
      if (row.decision === 'pending' && this.autoEligible(project, author)) {
        updated = repos.issues.patch(row.id, { decision: 'queued' });
      } else if (row.decision === 'needs_clarification' && changed && row.posted_comment_at) {
        // A reply arrived after our clarification comment → requalify.
        const comments = await this.github.issueComments(project.github_repo!, row.number).catch(() => []);
        const replied = comments.some(
          (cm) => !isPjGenComment(cm, ourLogin) && Date.parse(cm.createdAt) > row.posted_comment_at!
        );
        if (replied) updated = repos.issues.patch(row.id, { decision: this.autoEligible(project, author) ? 'queued' : 'pending' });
      }
      if (changed || updated.decision !== row.decision) this.emitIssue(updated);
    }
    for (const closed of repos.issues.markClosedExcept(project.id, remote.map((it) => it.number))) this.emitIssue(closed);
  }

  /**
   * Isolated security filter, run before ANY auto-routing (micro or reopen): a tool-less
   * session sees ONLY the issue title + body (no comment thread, no project docs, no
   * history) and decides whether the issue's objective is to harm pj-gen or the build
   * machine. Fails open (benign) on a session/parsing failure — a flaky check must not
   * jam the queue, and the downstream qualification session already treats the issue
   * body as untrusted data (see class doc).
   */
  private async checkIssueSecurity(issue: Pick<IssueRow, 'project_id' | 'title' | 'body'>): Promise<{ malicious: boolean; reason: string }> {
    const { repos, runner } = this.deps;
    const project = repos.projects.byId(issue.project_id)!;
    const sessionId = randomUUID();
    repos.sessions.insert(sessionId, project.id, 'issue_security');
    const { model, fallbackModel } = resolveModel(repos, project, 'issue_security');
    const caps = capsFor(repos, 'issue_security');
    const settings = repos.settings.getAll();
    const handle = runner({
      cwd: project.workspace_path,
      prompt: issueSecurityPrompt(issue.title, issue.body),
      sessionId,
      resume: false,
      model,
      fallbackModel,
      tools: 'none',
      jsonSchema: ISSUE_SECURITY_JSON_SCHEMA,
      maxBudgetUsd: settings.maxBudgetUsdPerSession,
      maxTurns: caps.maxTurns,
      timeoutMs: caps.timeoutMs,
    });
    const result = await handle.result;
    repos.sessions.bump(sessionId, result.numTurns, result.costUsd, result.usage);
    if (recordUsage(repos, project.id, 'issue_security', result)) this.deps.sched.emitQuota();
    repos.sessions.setStatus(sessionId, 'closed');
    if (result.outcome !== 'success') return { malicious: false, reason: '' };
    const parsed = extractStructured(IssueSecurityVerdictZ, result.structured, result.resultText);
    return parsed.ok ? parsed.data : { malicious: false, reason: '' };
  }

  /** One issue at a time per project: queued → micro request (issue body stays in the tool-less session). */
  private async drainQueued(project: ProjectRow, ourLogin: string | null): Promise<void> {
    const { repos } = this.deps;
    if (this.micro.quotaBlocked()) return;
    // One in-flight fix per project — including its CI wait: piling more fixes
    // on top of a possibly-red repo would compound the breakage.
    if (repos.issues.byDecision(project.id, ['fixing', 'ci_running']).length) return;
    const next = repos.issues.byDecision(project.id, ['queued'])[0];
    if (!next) return;
    const fresh = repos.projects.byId(project.id)!;
    if (!['deployed', 'awaiting_deploy_approval', 'building', 'failed'].includes(fresh.status)) return;

    const verdict = await this.checkIssueSecurity(next);
    if (verdict.malicious) {
      try {
        await this.github.issueComment(
          project.github_repo!,
          next.number,
          `pj-gen a détecté que cette issue vise à nuire à l'outil ou à la machine de build plutôt qu'à décrire une évolution produit, et ne la traitera pas automatiquement.\n\nMotif : ${verdict.reason || 'objectif de nuisance détecté'}.\n\n${AI_MENTION}`
        );
      } catch (err) {
        console.error(`[issuePoller] failed to post security-block comment on issue #${next.number}:`, err);
      }
      this.emitIssue(repos.issues.patch(next.id, { decision: 'blocked_security' }));
      return;
    }

    this.emitIssue(repos.issues.patch(next.id, { decision: 'fixing' }));
    // Comment thread: clarification replies (text + their attachments) are part of the request.
    const comments = await this.github.issueComments(project.github_repo!, next.number).catch(() => [] as IssueComment[]);
    // Attachments (screenshots, files) referenced in the body or comments: downloaded
    // locally so the implement session can Read them; a failed download degrades to the URL.
    const assets = await this.github
      .downloadIssueAttachments(project.id, next.number, [next.body, ...comments.map((cm) => cm.body ?? '')].join('\n'))
      .catch(() => []);
    const downloaded = assets.filter((a) => a.ok && a.file);
    const request = buildIssueRequest(next, comments, assets, ourLogin);
    const scope = classifyIssueScope(request);

    if (scope === 'full') {
      // The full pipeline (reopen) needs a settled project (REOPENABLE_STATUSES);
      // 'building' (allowed for micro) is not one of them — defer to a later tick.
      if (!REOPENABLE_STATUSES.includes(fresh.status)) {
        this.emitIssue(repos.issues.patch(next.id, { decision: 'queued' }));
        return;
      }
      try {
        await this.github.issueComment(
          project.github_repo!,
          next.number,
          `pj-gen prend en compte cette issue en mode **${MODE_LABEL.full}** : elle dépasse le périmètre d'une micro-modification. Le cadrage d'une itération démarre.\n\n${AI_MENTION}`
        );
      } catch (err) {
        console.error(`[issuePoller] failed to post mode comment on issue #${next.number}:`, err);
      }
      try {
        await this.spec.reopen(project.id, request);
        this.emitIssue(repos.issues.patch(next.id, { decision: 'escalated' }));
      } catch (err) {
        console.error(`[issuePoller] reopen failed for issue #${next.number}:`, err);
        this.emitIssue(repos.issues.patch(next.id, { decision: 'failed' }));
      }
      return;
    }

    try {
      await this.github.issueComment(
        project.github_repo!,
        next.number,
        `pj-gen prend en compte cette issue en mode **${MODE_LABEL.micro}**.\n\n${AI_MENTION}`
      );
    } catch (err) {
      console.error(`[issuePoller] failed to post mode comment on issue #${next.number}:`, err);
    }
    try {
      const outcome = await this.micro.create(project.id, request, 'issue', next.id, downloaded.map((a) => a.file!));
      if (outcome.status === 'needs_clarification') {
        await this.github.issueComment(
          project.github_repo!,
          next.number,
          `${outcome.question}\n\n${AI_MENTION}`
        );
        this.emitIssue(repos.issues.patch(next.id, { decision: 'needs_clarification', posted_comment_at: Date.now() }));
      } else if (outcome.status === 'failed') {
        this.emitIssue(repos.issues.patch(next.id, { decision: 'failed' }));
      }
      // queued/appended: stays 'fixing' — finalizeFixing settles it once the micro request is done.
    } catch {
      this.emitIssue(repos.issues.patch(next.id, { decision: 'failed' }));
    }
  }

  /**
   * Settle 'fixing' issues from their micro request: push (auto) → CI gate
   * ('ci_running' until the GitHub Actions runs of the pushed commit conclude)
   * → comment → close → fixed. A red CI leaves the issue OPEN ('failed'): the
   * issue is never marked done before CI passed. Repos without workflow files
   * skip the gate (nothing to wait for).
   */
  private async finalizeFixing(project: ProjectRow): Promise<void> {
    const { repos } = this.deps;
    for (const issue of repos.issues.byDecision(project.id, ['fixing', 'ci_running'])) {
      const mr = repos.micro.latestForIssue(issue.id);
      if (!mr) continue;

      if (issue.decision === 'fixing') {
        if (mr.status === 'failed') {
          this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed' }));
          continue;
        }
        if (mr.status !== 'done') continue;

        const fresh = repos.projects.byId(project.id)!;
        const autoPush = fresh.github_auto_mode === 1 && fresh.github_private === 1;
        // A push failure here (e.g. a merge conflict pushWithRetry could not resolve on its
        // own) must not leave the issue stuck in 'fixing' forever: that also blocks every
        // other queued issue behind it (drainQueued allows only one in-flight fix per project).
        // Surface it as a definite 'failed' instead of retrying the same error every tick.
        try {
          const sync = await this.github.syncState(fresh);
          if (autoPush) {
            if (['building', 'deploying'].includes(fresh.status)) continue; // retry next tick
            if (sync.ahead === null || sync.ahead > 0) await this.github.push(project.id, undefined, { autoResolve: true });
          } else if (sync.ahead === null || sync.ahead > 0) {
            continue; // manual flow: finalize only once the fix commit reached the remote
          }
        } catch (err) {
          const detail = (err as Error).message?.slice(0, 500) ?? 'échec de synchronisation avec le dépôt distant';
          await this.github
            .issueComment(project.github_repo!, issue.number, `Correctif prêt localement mais impossible à publier sur GitHub : ${detail}\n\n${AI_MENTION}`)
            .catch(() => undefined);
          this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed' }));
          continue;
        }

        if (!this.hasCiWorkflows(fresh)) {
          await this.closeFixed(project, issue, mr);
        } else {
          // posted_comment_at doubles as the CI wait start (no clarification pending here).
          this.emitIssue(repos.issues.patch(issue.id, { decision: 'ci_running', posted_comment_at: Date.now() }));
        }
        continue;
      }

      // ci_running: settle from the Actions runs of the last pushed commit.
      const fresh = repos.projects.byId(project.id)!;
      const sha = fresh.github_last_push_sha ?? (await this.deps.ws.headSha(fresh.workspace_path));
      const state = sha ? await this.github.ciStatus(fresh.github_repo!, sha) : 'none';
      if (state === 'success') {
        await this.closeFixed(project, issue, mr);
      } else if (state === 'failure') {
        await this.github.issueComment(
          project.github_repo!,
          issue.number,
          `La CI a échoué sur le commit \`${(sha ?? '').slice(0, 10)}\` après ce correctif — l'issue reste ouverte.\n\n${AI_MENTION}`
        );
        this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed', posted_comment_at: Date.now() }));
      } else if (Date.now() - (issue.posted_comment_at ?? 0) > CI_WAIT_MAX_MS) {
        await this.closeFixed(project, issue, mr, 'Statut CI non confirmé (aucun run concluant après 30 min).');
      }
      // 'pending'/'none' within the grace period: retry next tick.
    }
  }

  /** The pushed commit is CI-gated only if the workspace carries workflow files. */
  private hasCiWorkflows(project: ProjectRow): boolean {
    try {
      return fs.readdirSync(path.join(project.workspace_path, '.github', 'workflows')).some((f) => /\.ya?ml$/i.test(f));
    } catch {
      return false;
    }
  }

  /** Comment (what was done + AI marker) → close on GitHub → decision 'fixed'. */
  private async closeFixed(project: ProjectRow, issue: IssueRow, mr: MicroRequestRow, caveat?: string): Promise<void> {
    const { repos } = this.deps;
    const task = mr.task_key ? repos.tasks.get(project.id, mr.task_key) : undefined;
    const sha = task?.commit_sha ? ` (commit \`${task.commit_sha.slice(0, 10)}\`)` : '';
    const body = [
      `Correctif appliqué${sha} : **${task?.title ?? mr.request.slice(0, 100)}**`,
      '',
      task?.description ? task.description.slice(0, 600) : '',
      '',
      caveat ? `⚠️ ${caveat}` : '',
      '',
      `_Correctif ${AI_MARKER}`,
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n');
    await this.github.issueComment(project.github_repo!, issue.number, body);
    await this.github.issueClose(project.github_repo!, issue.number);
    this.emitIssue(repos.issues.patch(issue.id, { decision: 'fixed', posted_comment_at: Date.now() }));
  }
}
