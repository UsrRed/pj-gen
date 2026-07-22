import type { EventPayloads, ProjectStatus } from '@pjgen/shared';
import type { Repos } from '../db/repos/index.js';
import type { Bus } from './bus.js';

export interface NotifyMessage {
  title: string;
  body: string;
  tags: string;
}

export type SendFn = (url: string, msg: NotifyMessage) => Promise<void>;

const SEND_TIMEOUT_MS = 10_000;

/** HTTP headers are Latin-1 only — strip anything else (the UTF-8 body keeps the full text). */
function headerSafe(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x20-\xff]/g, '-').replace(/-{2,}/g, '-').trim();
}

/** ntfy.sh-compatible: plain-text body, metadata in X-* headers (plain webhooks just get the POST). */
export const defaultSend: SendFn = async (url, msg) => {
  await fetch(url, {
    method: 'POST',
    body: msg.body,
    headers: { 'X-Title': headerSafe(msg.title), 'X-Tags': headerSafe(msg.tags), 'content-type': 'text/plain; charset=utf-8' },
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
};

/**
 * Pushes webhook notifications for the overnight-queue events the user cares about:
 * a build reaching the deploy gate, a definitive failure, and the queue resuming after a quota reset.
 * Fire-and-forget: a failed delivery is logged, never retried, and never blocks the pipeline.
 */
export class Notifier {
  private lastStatus = new Map<string, ProjectStatus>();
  private wasLimited = false;

  constructor(
    private repos: Repos,
    private send: SendFn = defaultSend
  ) {}

  attach(bus: Bus): void {
    this.wasLimited = this.repos.quota.get().limited_until !== null;
    // Prime with current statuses so the first observed event is a real transition (no boot spam,
    // and no missed notification when a build settles right after a reboot).
    for (const p of this.repos.projects.all()) this.lastStatus.set(p.id, p.status);
    bus.subscribe({
      projectId: null,
      fn: (_id, type, _projectId, payload) => {
        if (type === 'project.updated') this.onProject((payload as EventPayloads['project.updated']).project);
        else if (type === 'quota.updated') this.onQuota((payload as EventPayloads['quota.updated']).quota);
      },
    });
  }

  private onProject(p: { id: string; title: string; status: ProjectStatus; errorMessage: string | null }): void {
    const prev = this.lastStatus.get(p.id);
    this.lastStatus.set(p.id, p.status);
    if (prev === p.status) return;
    const events = this.repos.settings.getAll().notifyEvents;
    if (p.status === 'awaiting_deploy_approval' && events.deployReady) {
      this.deliver({ title: 'pj-gen — prêt à déployer', body: `✅ « ${p.title} » a terminé son build et attend ton approbation.`, tags: 'white_check_mark' });
    } else if (p.status === 'failed' && events.buildFailed) {
      const reason = p.errorMessage ? ` : ${p.errorMessage.slice(0, 300)}` : '';
      this.deliver({ title: 'pj-gen — échec de build', body: `❌ « ${p.title} » est en échec${reason}`, tags: 'x' });
    }
  }

  private onQuota(q: { limitedUntil: number | null }): void {
    const nowLimited = q.limitedUntil !== null && q.limitedUntil > Date.now();
    const resumed = this.wasLimited && !nowLimited;
    this.wasLimited = nowLimited;
    if (!resumed || !this.repos.settings.getAll().notifyEvents.quotaResumed) return;
    const queued = this.repos.projects.queueSnapshot().queuedIds.length;
    if (queued === 0) return;
    this.deliver({
      title: 'pj-gen — quota réinitialisé',
      body: `▶️ Reprise de la file : ${queued} projet${queued > 1 ? 's' : ''} en attente.`,
      tags: 'arrow_forward',
    });
  }

  /** Public for the settings "test" button. Resolves with an error message instead of throwing. */
  async deliverTest(): Promise<{ ok: boolean; error?: string }> {
    const url = this.repos.settings.getAll().notifyUrl.trim();
    if (!url) return { ok: false, error: 'Aucune URL de notification configurée.' };
    try {
      await this.send(url, { title: 'pj-gen — test', body: 'Notification de test pj-gen ✓', tags: 'bell' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private deliver(msg: NotifyMessage): void {
    const url = this.repos.settings.getAll().notifyUrl.trim();
    if (!url) return;
    void this.send(url, msg).catch((err: Error) => {
      console.warn(`[pj-gen] notification non délivrée (${msg.title}): ${err.message}`);
    });
  }
}
