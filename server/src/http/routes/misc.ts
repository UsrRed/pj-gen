import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { MODEL_NAMES } from '@pjgen/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../container.js';
import { badRequest, notFound } from '../../core/httpError.js';
import { isSecretArtifact, listArtifacts } from '../../pipeline/artifacts.js';
import { toStepRunDto } from '../../db/repos/index.js';

const execFileP = promisify(execFile);

const SettingsPatchZ = z.object({
  maxConcurrentBuilds: z.number().int().min(1).max(4).optional(),
  maxConcurrentSessions: z.number().int().min(1).max(8).optional(),
  taskParallelism: z.number().int().min(1).max(4).optional(),
  defaultModel: z.enum(MODEL_NAMES).optional(),
  autoResumeOnBoot: z.boolean().optional(),
  skipTestHardening: z.boolean().optional(),
  maxBudgetUsdPerSession: z.number().min(0).max(100).optional(),
  stepCaps: z.record(z.object({ turns: z.number().int().min(1).max(200), timeoutMin: z.number().min(1).max(180) })).optional(),
  stepModels: z.record(z.enum(MODEL_NAMES)).optional(),
  designBenchmark: z.boolean().optional(),
  githubDefaultPrivate: z.boolean().optional(),
  issuePollMinutes: z.number().int().min(1).max(120).optional(),
  notifyUrl: z.union([z.literal(''), z.string().url().max(500)]).optional(),
  notifyEvents: z
    .object({ deployReady: z.boolean(), buildFailed: z.boolean(), quotaResumed: z.boolean() })
    .optional(),
  exposeLan: z.boolean().optional(),
});

export function registerMiscRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/steps/:runId/logs', async (req) => {
    const { runId } = req.params as { runId: string };
    const q = req.query as { afterSeq?: string; limit?: string };
    const run = c.repos.stepRuns.byId(Number(runId));
    if (!run) throw notFound('Run introuvable');
    const lines = c.repos.logs.listAfter(run.id, Number(q.afterSeq ?? -1), Math.min(Number(q.limit ?? 1000), 5000));
    return { run: toStepRunDto(run), lines };
  });

  app.get('/api/projects/:id/artifacts', async (req) => {
    const { id } = req.params as { id: string };
    const row = c.repos.projects.byId(id);
    if (!row) throw notFound('Projet introuvable');
    return { tree: listArtifacts(c.ws, row.workspace_path) };
  });

  app.get('/api/projects/:id/artifacts/file', async (req) => {
    const { id } = req.params as { id: string };
    const { path: relPath } = req.query as { path?: string };
    if (!relPath) throw badRequest('paramètre path requis');
    if (isSecretArtifact(relPath)) throw badRequest('Fichier protégé — les secrets ne sont pas lisibles par l’API');
    const row = c.repos.projects.byId(id);
    if (!row) throw notFound('Projet introuvable');
    let file: { content: string; truncated: boolean } | null;
    try {
      file = c.ws.readFile(row.workspace_path, relPath);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    if (!file) throw notFound('Fichier introuvable');
    return { path: relPath, ...file };
  });

  /** Opens the project workspace in the HOST machine's file manager (no-op on headless servers). */
  app.post('/api/projects/:id/open-folder', async (req) => {
    const { id } = req.params as { id: string };
    const row = c.repos.projects.byId(id);
    if (!row) throw notFound('Projet introuvable');
    try {
      await execFileP('xdg-open', [row.workspace_path], { timeout: 5000, env: process.env });
      return { ok: true };
    } catch {
      throw badRequest(
        "Impossible d'ouvrir le gestionnaire de fichiers sur la machine hôte (session sans interface graphique ?). Utilise le chemin copié dans un terminal : cd " +
          row.workspace_path
      );
    }
  });

  /** Aperçu: run the generated project's app inside its workspace. */
  app.get('/api/projects/:id/app', async (req) => {
    const { id } = req.params as { id: string };
    if (!c.repos.projects.byId(id)) throw notFound('Projet introuvable');
    return c.appRunner.state(id);
  });

  app.post('/api/projects/:id/app/start', async (req) => {
    const { id } = req.params as { id: string };
    if (!c.repos.projects.byId(id)) throw notFound('Projet introuvable');
    try {
      return c.appRunner.start(id);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  app.post('/api/projects/:id/app/stop', async (req) => {
    const { id } = req.params as { id: string };
    await c.appRunner.stop(id);
    return { ok: true };
  });

  app.get('/api/settings', async () => c.repos.settings.getAll());

  app.patch('/api/settings', async (req) => {
    const body = SettingsPatchZ.parse(req.body);
    const updated = c.repos.settings.set(body);
    if (body.exposeLan !== undefined) await c.lan.apply(updated.exposeLan);
    c.scheduler.poke();
    return updated;
  });

  app.get('/api/lan', async () => c.lan.status());

  app.post('/api/settings/notify-test', async () => {
    const r = await c.notifier.deliverTest();
    if (!r.ok) throw badRequest(r.error ?? 'Échec de la notification de test');
    return { ok: true };
  });

  app.get('/api/quota', async () => c.scheduler.getQuotaDto());

  app.get('/api/stats', async () => ({
    days: c.repos.usage.statsDays(14),
    perStep: c.repos.usage.statsPerStep(),
    perProject: c.repos.usage.statsPerProject(10),
    cacheRate: c.repos.usage.cacheRate(),
    timePerStep: c.repos.usage.timePerStep(),
    timePerProject: c.repos.usage.timePerProject(10),
  }));

  /** Probe: clear the recorded limit and let the scheduler retry immediately (free if still limited). */
  app.post('/api/quota/probe', async () => {
    c.repos.quota.clear();
    c.bus.emit('quota.updated', null, { quota: c.scheduler.getQuotaDto() });
    c.scheduler.poke();
    return { ok: true };
  });

  app.get('/api/health', async () => ({
    ok: true,
    fakeCli: c.config.fakeCli,
    claudeVersion: c.caps.version,
    claudeOk: c.caps.ok,
    versionWarning: c.caps.versionWarning,
  }));
}
