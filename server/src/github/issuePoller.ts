import fs from 'node:fs';
import path from 'node:path';
import type { CoreDeps } from '../core/deps.js';
import type { GithubService } from './githubService.js';
import type { MicroService } from '../micro/microService.js';
import type { AssetResult } from './issueAssets.js';
import { toIssueDto, type IssueRow, type MicroRequestRow, type ProjectRow } from '../db/repos/index.js';

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
        .map((a) => (a.ok && a.file ? `- ${a.file} (téléchargée depuis ${a.url})` : `- ${a.url} (téléchargement échoué : ${a.error ?? '?'})`))
        .join('\n')}`
    : '';
  return `Issue GitHub #${issue.number} de @${issue.author} — ${issue.title}\n\n${issue.body}${commentsBlock}${assetsBlock}`;
}

/**
 * Auto-issue fixer: periodically syncs open GitHub issues of linked projects,
 * auto-enqueues them (auto-mode projects on PRIVATE repos, or trusted authors),
 * turns queued issues into micro-modifications, and finalizes fixed ones
 * (push if auto, comment with what was done + AI mention, close).
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
    private micro: MicroService
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

  /** One issue at a time per project: queued → micro request (issue body stays in the tool-less session). */
  private async drainQueued(project: ProjectRow, ourLogin: string | null): Promise<void> {
    const { repos, ws } = this.deps;
    if (this.micro.quotaBlocked()) return;
    // One in-flight fix per project — including its CI wait: piling more fixes
    // on top of a possibly-red repo would compound the breakage.
    if (repos.issues.byDecision(project.id, ['fixing', 'ci_running']).length) return;
    const next = repos.issues.byDecision(project.id, ['queued'])[0];
    if (!next) return;
    const fresh = repos.projects.byId(project.id)!;
    if (!['deployed', 'awaiting_deploy_approval', 'building', 'failed'].includes(fresh.status)) return;
    // A freshly-cloned import's adoption session (analyzeImport) writes docs/SPEC.md
    // asynchronously right after the clone — a poll tick can race ahead of it.
    // generateTask hard-requires SPEC.md; treating its absence as a real failure here
    // would permanently poison the issue (unlike needs_clarification, a 'failed' issue
    // is never auto-requeued). Retry next tick instead.
    if (!ws.readFile(fresh.workspace_path, 'docs/SPEC.md')) return;

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
        const sync = await this.github.syncState(fresh);
        if (autoPush) {
          if (['building', 'deploying'].includes(fresh.status)) continue; // retry next tick
          if (sync.ahead === null || sync.ahead > 0) await this.github.push(project.id);
        } else if (sync.ahead === null || sync.ahead > 0) {
          continue; // manual flow: finalize only once the fix commit reached the remote
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
