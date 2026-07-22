import { afterEach, describe, expect, it } from 'vitest';
import type { Container } from '../src/container.js';
import type { NotifyMessage } from '../src/core/notifier.js';
import { fastScript, seedQueuedProject, testContainer, waitFor } from './helpers.js';

let cRef: Container | null = null;
afterEach(() => {
  cRef?.close();
  cRef = null;
});

async function notifyingContainer(sent: { url: string; msg: NotifyMessage }[]) {
  const { c } = await testContainer({
    notifySend: async (url, msg) => {
      sent.push({ url, msg });
    },
  });
  c.repos.settings.set({ notifyUrl: 'https://ntfy.example/test' });
  return c;
}

describe('Notifier', () => {
  it('notifies when a build reaches the deploy gate (full fake pipeline)', async () => {
    const sent: { url: string; msg: NotifyMessage }[] = [];
    const c = await notifyingContainer(sent);
    cRef = c;
    const id = await seedQueuedProject(c, 'Notif Deploy');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');
    await waitFor(() => sent.length > 0, 2000, 'notification envoyée');

    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://ntfy.example/test');
    expect(sent[0].msg.body).toContain('Notif Deploy');
    expect(sent[0].msg.body).toContain('✅');
  });

  it('notifies on definitive failure with the error message', async () => {
    const sent: { url: string; msg: NotifyMessage }[] = [];
    const { c } = await testContainer({
      notifySend: async (url, msg) => {
        sent.push({ url, msg });
      },
      script: fastScript((spec) => {
        const props = Object.keys((spec.jsonSchema as { properties?: object } | undefined)?.properties ?? {});
        if (props.includes('architecture_markdown')) {
          return { delayMs: 10, result: { outcome: 'failure', failure: { kind: 'crash', message: 'boom archi' } } };
        }
        return undefined;
      }),
    });
    cRef = c;
    c.repos.settings.set({ notifyUrl: 'https://ntfy.example/test' });
    const id = await seedQueuedProject(c, 'Notif Fail');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'failed', 10_000, 'échec projet');
    await waitFor(() => sent.length > 0, 2000, 'notification échec');

    expect(sent[0].msg.body).toContain('❌');
    expect(sent[0].msg.body).toContain('Notif Fail');
  });

  it('notifies when the quota clears with a non-empty queue — and stays silent otherwise', async () => {
    const sent: { url: string; msg: NotifyMessage }[] = [];
    const c = await notifyingContainer(sent);
    cRef = c;
    // Queue a project but DON'T start the scheduler: it stays queued.
    await seedQueuedProject(c, 'Parked');

    c.scheduler.notifyQuotaLimit(Date.now() + 3600_000, 'test');
    expect(sent).toHaveLength(0);
    c.repos.quota.clear();
    c.scheduler.emitQuota();
    await waitFor(() => sent.length > 0, 2000, 'notification reprise');
    expect(sent[0].msg.body).toContain('▶️');
    expect(sent[0].msg.body).toContain('1 projet');

    // Cleared again with nothing queued → silence.
    sent.length = 0;
    c.repos.projects.casStatus('parked-id', ['queued'], 'canceled');
    c.scheduler.notifyQuotaLimit(Date.now() + 3600_000, 'test');
    c.repos.quota.clear();
    c.scheduler.emitQuota();
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
  });

  it('respects toggles and an empty URL', async () => {
    const sent: { url: string; msg: NotifyMessage }[] = [];
    const c = await notifyingContainer(sent);
    cRef = c;
    c.repos.settings.set({ notifyEvents: { deployReady: false, buildFailed: true, quotaResumed: true } });
    const id = await seedQueuedProject(c, 'Muted');
    c.scheduler.start();
    await waitFor(() => c.repos.projects.byId(id)!.status === 'awaiting_deploy_approval', 15_000, 'pipeline complet');
    await new Promise((r) => setTimeout(r, 150));
    expect(sent).toHaveLength(0); // deployReady désactivé

    const test1 = await c.notifier.deliverTest();
    expect(test1.ok).toBe(true);
    c.repos.settings.set({ notifyUrl: '' });
    const test2 = await c.notifier.deliverTest();
    expect(test2.ok).toBe(false);
  });
});
