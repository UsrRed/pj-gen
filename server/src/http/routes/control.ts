import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { ProjectStateMachine } from '../../core/stateMachine.js';
import { badRequest } from '../../core/httpError.js';

const CutZ = z.object({
  targetAt: z.number().int().positive(),
  reservePct: z.number().int().min(1).max(100),
});

/** Global controls: pause-all / resume-all and the (single) scheduled token cut. */
export function registerControlRoutes(app: FastifyInstance, c: Container): void {
  const sm = new ProjectStateMachine(c.repos.projects);

  app.post('/api/control/pause-all', async () => {
    c.scheduler.pauseAll();
    return { ok: true };
  });

  app.post('/api/control/resume-all', async () => {
    // Resume during a BINDING cut is an explicit override: drop the cut, otherwise the
    // scheduler would re-pause on the very next poke. A pending (non-binding) cut stays.
    if (c.scheduler.getQuotaDto().scheduledCut?.binding) {
      c.repos.settings.setScheduledCut(null);
      c.scheduler.cutChanged();
    }
    c.repos.settings.setGlobalPaused(false);
    const rows = c.repos.projects.byStatus(['paused_user', 'interrupted']);
    let resumed = 0;
    for (const row of rows) {
      // tryTransition: a race on one project must not 500 the whole batch.
      if (sm.tryTransition(row.id, [row.status], 'queued', { enqueued_at: row.enqueued_at ?? Date.now() })) {
        resumed += 1;
        const fresh = c.repos.projects.byId(row.id);
        if (fresh) c.bus.emit('project.updated', row.id, { project: c.repos.projects.summary(fresh) });
      }
    }
    c.bus.emit('queue.updated', null, c.repos.projects.queueSnapshot());
    c.scheduler.emitQuota();
    c.scheduler.poke();
    return { ok: true, resumed };
  });

  app.post('/api/control/cut', async (req) => {
    const body = CutZ.parse(req.body);
    if (body.targetAt <= Date.now()) throw badRequest("targetAt doit être dans le futur");
    c.repos.settings.setScheduledCut(body);
    c.scheduler.cutChanged();
    return { ok: true, quota: c.scheduler.getQuotaDto() };
  });

  app.delete('/api/control/cut', async () => {
    c.repos.settings.setScheduledCut(null);
    c.scheduler.cutChanged();
    return { ok: true };
  });
}
