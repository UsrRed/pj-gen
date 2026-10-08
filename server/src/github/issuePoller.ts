import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { REOPENABLE_STATUSES, type IssueDecision } from '@pjgen/shared';
import type { CoreDeps } from '../core/deps.js';
import type { GithubService } from './githubService.js';
import { isWorkflowScopeRejection, WORKFLOW_SCOPE_MESSAGE } from './githubService.js';
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
/**
 * Issue-driven cadrage: questions asked while the session already judged the request
 * ready (defaults proposed) fall back to those defaults after this silence, so an
 * unanswered issue does not hold the project in cadrage forever.
 */
const CADRAGE_DEFAULTS_AFTER_MS = 24 * 3_600_000;
/** A cadrage turn / SPEC generation that left nothing behind (quota, auth…) is retried after this. */
const CADRAGE_RETRY_MS = 30 * 60_000;
/** Issue decisions holding the project's single in-flight slot. */
const IN_FLIGHT: IssueDecision[] = ['fixing', 'ci_running', 'escalated', 'awaiting_reply'];

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

/**
 * Comment asking the issue thread the cadrage session's open questions: the issue is the
 * only channel of an issue-driven iteration (nobody is expected on the pj-gen UI). Pure.
 */
export function cadrageQuestionComment(reply: string, questions: string[], ready: boolean, iteration: number): string {
  const list = questions.length ? `\n\n**Questions** — répondez directement dans cette issue :\n\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}` : '';
  const fallback = ready
    ? '\n\nSans réponse sous 24 h, les choix par défaut proposés ci-dessus seront appliqués et la construction démarrera.'
    : "\n\nLa construction démarrera dès que ces points seront tranchés ici.";
  return `**Cadrage — itération ${iteration}** (pipeline complet)\n\n${reply.trim()}${list}${fallback}\n\n${AI_MENTION}`;
}

/** Highest task position of a project (-1 when it has none): tasks above it are a new iteration's. */
function lastTaskPosition(tasks: { position: number }[]): number {
  return tasks.reduce((max, t) => Math.max(max, t.position), -1);
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
  /** A poke that arrived mid-tick: run another tick right after instead of dropping it. */
  private pokeAgain = false;
  /** Last automatic attempt of a cadrage turn replay / SPEC generation, per issue id. */
  private turnRetryAt = new Map<number, number>();
  private specAttemptAt = new Map<number, number>();

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
        if (type === 'micro.updated') {
          const req = (payload as { request?: { source?: string } }).request;
          if (req?.source === 'issue') this.poke();
        } else if (type === 'chat.message') {
          // A cadrage reply may have to go to an issue thread.
          const msg = (payload as { message?: { role?: string; sessionKind?: string } }).message;
          if (msg?.role === 'assistant' && msg.sessionKind === 'cadrage') this.poke();
        } else if (type === 'project.updated') {
          // spec_ready (validate), deployed / awaiting approval (deliver), failed (report).
          const status = (payload as { project?: { status?: string } }).project?.status;
          if (status && ['spec_ready', 'deployed', 'awaiting_deploy_approval', 'failed'].includes(status)) this.poke();
        }
      },
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  poke(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pokeAgain = true;
      return;
    }
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
                  await this.advanceEscalated(project);
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
      if (this.pokeAgain) {
        this.pokeAgain = false;
        this.poke();
      } else {
        this.schedule();
      }
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
      } else if (row.decision === 'awaiting_reply' && changed && row.posted_comment_at) {
        // Answers to the cadrage questions of an issue-driven iteration → next cadrage turn.
        const answers = await this.cadrageAnswers(project, row, ourLogin);
        if (answers) {
          updated = repos.issues.patch(row.id, { decision: 'escalated' });
          void this.spec.continueCadrage(project.id, answers).catch((err) => console.error(`[issuePoller] cadrage turn failed for issue #${row.number}:`, err));
        }
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
    // A full iteration opened for an issue (escalated / awaiting_reply) holds it too.
    if (repos.issues.byDecision(project.id, IN_FLIGHT).length) return;
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

    this.emitIssue(repos.issues.patch(next.id, { decision: 'fixing', iteration: null, task_floor: null }));
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
          `pj-gen prend en compte cette issue en mode **${MODE_LABEL.full}** : elle dépasse le périmètre d'une micro-modification. Le cadrage d'une itération démarre ; s'il reste des points à trancher, les questions seront posées ici, puis la construction et la publication se feront automatiquement.\n\n${AI_MENTION}`
        );
      } catch (err) {
        console.error(`[issuePoller] failed to post mode comment on issue #${next.number}:`, err);
      }
      // Marked before reopen: its first cadrage turn must already see an issue-driven iteration.
      this.emitIssue(
        repos.issues.patch(next.id, {
          decision: 'escalated',
          iteration: (fresh.iteration ?? 1) + 1,
          task_floor: lastTaskPosition(repos.tasks.list(project.id)),
          posted_comment_at: null,
        })
      );
      try {
        await this.spec.reopen(project.id, request);
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
      // A delivered full iteration (iteration set) settles without any micro request.
      const close = (caveat?: string) =>
        issue.iteration !== null || !mr ? this.closeIteration(project, issue, caveat) : this.closeFixed(project, issue, mr, caveat);

      if (issue.decision === 'fixing') {
        if (!mr) continue;
        if (mr.status === 'failed') {
          // Say why on the issue: it stays OPEN, and the reason (e.g. the request check's
          // remaining gaps) is what the author needs to rephrase or retry.
          const reason = mr.error_message ? `\n\n${mr.error_message.slice(0, 1500)}` : '';
          await this.github
            .issueComment(project.github_repo!, issue.number, `pj-gen n'a pas pu résoudre cette issue — elle reste ouverte.${reason}\n\n${AI_MENTION}`)
            .catch(() => undefined);
          this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed', posted_comment_at: Date.now() }));
          continue;
        }
        if (mr.status === 'escalated') {
          // The engine reopened the project for a full iteration (scope beyond a micro fix):
          // from here on the issue drives that iteration (advanceEscalated).
          const reopened = repos.projects.byId(project.id)!;
          await this.github
            .issueComment(
              project.github_repo!,
              issue.number,
              `Cette correction dépasse une micro-modification : pj-gen bascule en **${MODE_LABEL.full}** (itération ${reopened.iteration}). Les éventuelles questions de cadrage seront posées ici, puis la construction et la publication se feront automatiquement.\n\n${AI_MENTION}`
            )
            .catch(() => undefined);
          this.emitIssue(
            repos.issues.patch(issue.id, {
              decision: 'escalated',
              iteration: reopened.iteration,
              task_floor: lastTaskPosition(repos.tasks.list(project.id)),
              posted_comment_at: null,
            })
          );
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
          if (isWorkflowScopeRejection(err) || (err as Error).message === WORKFLOW_SCOPE_MESSAGE) {
            // Not a defect of this fix: every publication is blocked until the user grants the
            // scope. Stay 'fixing' (retried each tick, publishes by itself once granted) and say
            // why once, instead of failing every issue one after the other.
            if (!issue.posted_comment_at) {
              await this.github
                .issueComment(project.github_repo!, issue.number, `Correctif prêt localement, publication en attente : ${WORKFLOW_SCOPE_MESSAGE}\n\n${AI_MENTION}`)
                .catch(() => undefined);
              this.emitIssue(repos.issues.patch(issue.id, { posted_comment_at: Date.now() }));
            }
            continue;
          }
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
        await close();
      } else if (state === 'failure') {
        await this.github.issueComment(
          project.github_repo!,
          issue.number,
          `La CI a échoué sur le commit \`${(sha ?? '').slice(0, 10)}\` après ce correctif — l'issue reste ouverte.\n\n${AI_MENTION}`
        );
        this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed', posted_comment_at: Date.now() }));
      } else if (Date.now() - (issue.posted_comment_at ?? 0) > CI_WAIT_MAX_MS) {
        await close('Statut CI non confirmé (aucun run concluant après 30 min).');
      }
      // 'pending'/'none' within the grace period: retry next tick.
    }
  }

  /**
   * Answers posted on the issue since our cadrage questions, formatted as the next cadrage
   * message; null when none. Only the issue author, the owner and trusted users are heard
   * on a public repo (anyone with access on a private one).
   */
  private async cadrageAnswers(project: ProjectRow, issue: IssueRow, ourLogin: string | null): Promise<string | null> {
    const comments = await this.github.issueComments(project.github_repo!, issue.number).catch(() => [] as IssueComment[]);
    const answers = comments.filter((cm) => {
      if (isPjGenComment(cm, ourLogin) || Date.parse(cm.createdAt) <= issue.posted_comment_at!) return false;
      const login = cm.author?.login ?? '';
      return project.github_private === 1 || login === issue.author || login === ourLogin || this.deps.repos.issues.isTrusted(login);
    });
    if (!answers.length) return null;
    const thread = answers
      .slice(-MAX_COMMENTS)
      .map((cm) => `@${cm.author?.login ?? 'inconnu'} — ${cm.createdAt} :\n${(cm.body ?? '').slice(0, MAX_COMMENT_CHARS)}`)
      .join('\n\n---\n\n');
    return `Réponse sur l'issue GitHub #${issue.number} :\n\n${thread}`;
  }

  /**
   * Drives a full iteration opened for a GitHub issue without the pj-gen UI: the cadrage
   * questions go to the issue thread (answers come back through syncProject), the SPEC is
   * generated and validated as soon as nothing is left open, and the delivered iteration
   * is pushed (auto mode), CI-gated and closed like a micro fix.
   */
  private async advanceEscalated(project: ProjectRow): Promise<void> {
    const { repos } = this.deps;
    for (const row of repos.issues.byDecision(project.id, ['escalated', 'awaiting_reply'])) {
      const fresh = repos.projects.byId(project.id)!;
      // Escalations from before the iteration column: the current iteration is theirs.
      const issue = row.iteration === null ? repos.issues.patch(row.id, { iteration: fresh.iteration }) : row;
      if (fresh.iteration < issue.iteration!) continue; // reopen still landing
      const current = fresh.iteration === issue.iteration;

      if (current && (fresh.status === 'draft' || fresh.status === 'spec_ready')) {
        await this.advanceCadrage(fresh, issue);
      } else if (fresh.status === 'deployed' || fresh.status === 'awaiting_deploy_approval') {
        await this.deliverIteration(fresh, issue);
      } else if (current && (fresh.status === 'failed' || fresh.status === 'canceled')) {
        const why = fresh.status === 'failed' ? `la construction a échoué${fresh.error_message ? ` (${fresh.error_message.slice(0, 800)})` : ''}` : "l'itération a été annulée";
        await this.github
          .issueComment(project.github_repo!, issue.number, `pj-gen n'a pas pu livrer cette issue : ${why}. Elle reste ouverte.\n\n${AI_MENTION}`)
          .catch(() => undefined);
        this.emitIssue(repos.issues.patch(issue.id, { decision: 'failed', posted_comment_at: Date.now() }));
      } else if (issue.decision === 'awaiting_reply') {
        // Settled from the UI meanwhile (spec validated there): back to tracking the build.
        this.emitIssue(repos.issues.patch(issue.id, { decision: 'escalated' }));
      }
      // queued / building / paused / interrupted / deploying: the build is on its way.
    }
  }

  /** Cadrage phase of an issue-driven iteration: ask on the issue, or move on to the build. */
  private async advanceCadrage(project: ProjectRow, issue: IssueRow): Promise<void> {
    const { repos } = this.deps;
    if (this.spec.isGenerating(project.id)) return;
    if (project.status === 'spec_ready') {
      await this.launchBuild(project, issue, null);
      return;
    }
    const msgs = repos.messages
      .listByKind(project.id, 'cadrage', 50)
      .filter((m) => m.role !== 'system' && m.created_at >= (project.reopened_at ?? 0));
    const last = msgs.at(-1);
    if (!last) return;
    if (last.role === 'user') {
      // Turn in flight — or lost to a quota/auth failure: replay it once clearly stale.
      const stale = Date.now() - last.created_at > CADRAGE_RETRY_MS && Date.now() - (this.turnRetryAt.get(issue.id) ?? 0) > CADRAGE_RETRY_MS;
      if (stale && !repos.quota.isLimited()) {
        this.turnRetryAt.set(issue.id, Date.now());
        await this.spec.continueCadrage(project.id, last.content, { skipUserInsert: true });
      }
      return;
    }

    let questions: string[] = [];
    let ready = false;
    try {
      const st = JSON.parse(last.structured ?? '{}') as { open_questions?: unknown; ready_for_spec?: unknown };
      questions = Array.isArray(st.open_questions) ? st.open_questions.map(String).filter((q) => q.trim()) : [];
      ready = st.ready_for_spec === true;
    } catch {
      // unstructured reply: treated as a question to the author
    }
    const alreadyPosted = (issue.posted_comment_at ?? 0) >= last.created_at;

    if (!alreadyPosted && (questions.length || !ready)) {
      try {
        await this.github.issueComment(project.github_repo!, issue.number, cadrageQuestionComment(last.content, questions, ready, project.iteration));
      } catch (err) {
        console.error(`[issuePoller] failed to post cadrage questions on issue #${issue.number}:`, err);
        return; // retried next tick
      }
      this.emitIssue(repos.issues.patch(issue.id, { decision: 'awaiting_reply', posted_comment_at: Date.now() }));
      return;
    }
    if (!ready) return; // waiting for the author
    const timedOut = alreadyPosted && questions.length > 0 && Date.now() - issue.posted_comment_at! > CADRAGE_DEFAULTS_AFTER_MS;
    if (questions.length && !timedOut) return;

    // A generation that left the project in draft (quota, invalid output) is retried later.
    if (Date.now() - (this.specAttemptAt.get(issue.id) ?? 0) < CADRAGE_RETRY_MS || repos.quota.isLimited()) return;
    this.specAttemptAt.set(issue.id, Date.now());
    await this.spec.generateSpec(project.id);
    const after = repos.projects.byId(project.id)!;
    if (after.status !== 'spec_ready') return;
    this.specAttemptAt.delete(issue.id);
    await this.launchBuild(
      after,
      repos.issues.byId(issue.id)!,
      timedOut ? 'Sans réponse depuis 24 h : les choix par défaut proposés ont été appliqués.' : alreadyPosted ? null : last.content
    );
  }

  /** spec_ready → validated SPEC → queued, announced on the issue. */
  private async launchBuild(project: ProjectRow, issue: IssueRow, note: string | null): Promise<void> {
    const { repos, ws } = this.deps;
    try {
      await this.spec.validateSpec(project.id);
    } catch (err) {
      console.error(`[issuePoller] spec validation failed for issue #${issue.number}:`, err);
      return;
    }
    const title = ws.readFile(project.workspace_path, 'docs/SPEC.md')?.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const body = [
      `**Cadrage terminé — itération ${project.iteration}**${title ? ` : ${title}` : ''}`,
      note ? `\n${note.trim().slice(0, 3000)}` : '',
      "\nSPEC révisée validée, construction lancée (pipeline complet). Le résultat sera publié sur le dépôt et cette issue close automatiquement une fois livré.",
      `\n${AI_MENTION}`,
    ].join('\n');
    await this.github.issueComment(project.github_repo!, issue.number, body).catch(() => undefined);
    this.emitIssue(repos.issues.patch(issue.id, { decision: 'escalated', posted_comment_at: Date.now() }));
  }

  /** Delivered iteration: push (auto) → CI gate (ci_running, settled by finalizeFixing) → close. */
  private async deliverIteration(project: ProjectRow, issue: IssueRow): Promise<void> {
    const autoPush = project.github_auto_mode === 1 && project.github_private === 1;
    try {
      const sync = await this.github.syncState(project);
      if (autoPush) {
        if (sync.ahead === null || sync.ahead > 0) await this.github.push(project.id, undefined, { autoResolve: true });
      } else if (sync.ahead === null || sync.ahead > 0) {
        return; // manual flow: settle only once the iteration reached the remote
      }
    } catch (err) {
      const detail = (err as Error).message?.slice(0, 500) ?? 'échec de synchronisation avec le dépôt distant';
      await this.github
        .issueComment(project.github_repo!, issue.number, `Itération prête localement mais impossible à publier sur GitHub : ${detail}\n\n${AI_MENTION}`)
        .catch(() => undefined);
      this.emitIssue(this.deps.repos.issues.patch(issue.id, { decision: 'failed' }));
      return;
    }
    const fresh = this.deps.repos.projects.byId(project.id)!;
    if (!this.hasCiWorkflows(fresh)) await this.closeIteration(fresh, issue);
    else this.emitIssue(this.deps.repos.issues.patch(issue.id, { decision: 'ci_running', posted_comment_at: Date.now() }));
  }

  /** Comment (iteration delivered + its tasks + AI marker) → close on GitHub → decision 'fixed'. */
  private async closeIteration(project: ProjectRow, issue: IssueRow, caveat?: string): Promise<void> {
    const { repos, ws } = this.deps;
    const fresh = repos.projects.byId(project.id)!;
    const sha = fresh.github_last_push_sha ?? (await ws.headSha(fresh.workspace_path));
    const title = ws.readFile(fresh.workspace_path, 'docs/SPEC.md')?.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const tasks =
      issue.task_floor === null ? [] : repos.tasks.list(project.id).filter((t) => t.position > issue.task_floor! && t.status === 'done');
    const body = [
      `Itération ${issue.iteration ?? fresh.iteration} livrée et publiée${sha ? ` (commit \`${sha.slice(0, 10)}\`)` : ''}${title ? ` : **${title}**` : ''}`,
      '',
      tasks.length ? `Tâches réalisées :\n${tasks.slice(0, 30).map((t) => `- ${t.task_key} — ${t.title}`).join('\n')}` : '',
      '',
      caveat ? `⚠️ ${caveat}` : '',
      '',
      AI_MENTION,
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n');
    await this.github.issueComment(project.github_repo!, issue.number, body);
    await this.github.issueClose(project.github_repo!, issue.number);
    this.emitIssue(repos.issues.patch(issue.id, { decision: 'fixed', posted_comment_at: Date.now() }));
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
    // Verdict of the request check (pipeline step request_check), when one ran.
    const check = mr.task_key ? this.deps.ws.readFile(project.workspace_path, `docs/request-checks/${mr.task_key.toLowerCase()}.md`) : null;
    const checkLines = check ? check.content.split('\n').slice(2).join('\n').trim().slice(0, 1500) : '';
    const body = [
      `Correctif appliqué${sha} : **${task?.title ?? mr.request.slice(0, 100)}**`,
      '',
      task?.description ? task.description.slice(0, 600) : '',
      '',
      checkLines ? `**Contrôle de la demande** :\n\n${checkLines}` : '',
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
