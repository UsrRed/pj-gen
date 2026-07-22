import type { CoreDeps } from '../core/deps.js';
import type { GithubService } from './githubService.js';
import type { MicroService } from '../micro/microService.js';
import type { AssetResult } from './issueAssets.js';
import { toIssueDto, type IssueRow, type ProjectRow } from '../db/repos/index.js';

const AI_MENTION = '_Message généré par IA (pj-gen)._';
/** Comment thread bounds fed to the qualification session (untrusted input). */
const MAX_COMMENTS = 10;
const MAX_COMMENT_CHARS = 2_000;

export interface IssueComment {
  author: { login: string } | null;
  createdAt: string;
  body: string;
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
      const who = ourLogin && login === ourLogin ? 'pj-gen (notre commentaire)' : `@${login}`;
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
          for (const project of linked) {
            try {
              await this.syncProject(project, status.login);
              await this.finalizeFixing(project);
              await this.drainQueued(project, status.login);
            } catch {
              /* one project failing must not block the others */
            }
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
      const author = it.author?.login ?? 'unknown';
      // Never react to our own issues (comment loops).
      if (ourLogin && author === ourLogin) continue;
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
          (cm) => (!ourLogin || cm.author?.login !== ourLogin) && Date.parse(cm.createdAt) > row.posted_comment_at!
        );
        if (replied) updated = repos.issues.patch(row.id, { decision: this.autoEligible(project, author) ? 'queued' : 'pending' });
      }
      if (changed || updated.decision !== row.decision) this.emitIssue(updated);
    }
    for (const closed of repos.issues.markClosedExcept(project.id, remote.map((it) => it.number))) this.emitIssue(closed);
  }

  /** One issue at a time per project: queued → micro request (issue body stays in the tool-less session). */
  private async drainQueued(project: ProjectRow, ourLogin: string | null): Promise<void> {
    const { repos } = this.deps;
    if (this.micro.quotaBlocked()) return;
    if (repos.issues.byDecision(project.id, ['fixing']).length) return;
    const next = repos.issues.byDecision(project.id, ['queued'])[0];
    if (!next) return;
    const fresh = repos.projects.byId(project.id)!;
    if (!['deployed', 'awaiting_deploy_approval', 'building', 'failed'].includes(fresh.status)) return;

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

  /** Settle 'fixing' issues from their micro request: push (auto) → comment → close → fixed. */
  private async finalizeFixing(project: ProjectRow): Promise<void> {
    const { repos } = this.deps;
    for (const issue of repos.issues.byDecision(project.id, ['fixing'])) {
      const mr = repos.micro.latestForIssue(issue.id);
      if (!mr) continue;
      if (mr.status === 'failed') {
        this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed' }));
        continue;
      }
      if (mr.status !== 'done') continue;

      const fresh = repos.projects.byId(project.id)!;
      const autoPush = fresh.github_auto_mode === 1 && fresh.github_private === 1;
      if (autoPush) {
        if (['building', 'deploying'].includes(fresh.status)) continue; // retry next tick
        await this.github.push(project.id);
      } else {
        // Manual flow: finalize only once the fix commit reached the remote.
        const sync = await this.github.syncState(fresh);
        if (sync.ahead === null || sync.ahead > 0) continue;
      }

      const task = mr.task_key ? repos.tasks.get(project.id, mr.task_key) : undefined;
      const sha = task?.commit_sha ? ` (commit \`${task.commit_sha.slice(0, 10)}\`)` : '';
      const body = [
        `Correctif appliqué${sha} : **${task?.title ?? mr.request.slice(0, 100)}**`,
        '',
        task?.description ? task.description.slice(0, 600) : '',
        '',
        `_Correctif généré par IA (pj-gen)._`,
      ]
        .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
        .join('\n');
      await this.github.issueComment(project.github_repo!, issue.number, body);
      await this.github.issueClose(project.github_repo!, issue.number);
      this.emitIssue(repos.issues.patch(issue.id, { decision: 'fixed', posted_comment_at: Date.now() }));
    }
  }
}
