import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { MODEL_NAMES } from '@pjgen/shared';
import type { ProjectDetail } from '@pjgen/shared';
import type { Container } from '../../container.js';
import type { ProjectRow } from '../../db/repos/index.js';
import { toMessageDto, toMicroDto, toStepRunDto, toTaskDto } from '../../db/repos/index.js';
import { ProjectStateMachine } from '../../core/stateMachine.js';
import { conflict, notFound } from '../../core/httpError.js';
import { slugify } from '../../pipeline/workspace.js';

const DesignZ = z.object({
  designContent: z.string().max(400_000).optional(),
  designUrl: z.string().max(2000).optional(),
});

const CreateZ = z
  .object({
    title: z.string().min(1).max(120),
    initialPrompt: z.string().min(1).max(20_000),
    model: z.enum(MODEL_NAMES).nullish(),
  })
  .merge(DesignZ);

const ChatZ = z.object({ content: z.string().min(1).max(20_000) });
const ApproveZ = z.object({ notes: z.string().max(20_000).default('') });
const ReopenZ = z.object({ request: z.string().min(1).max(20_000) }).merge(DesignZ);

function detail(c: Container, row: ProjectRow): ProjectDetail {
  return {
    ...c.repos.projects.summary(row),
    initialPrompt: row.initial_prompt,
    stack: c.repos.projects.stackOf(row),
    stepModelOverrides: c.repos.projects.stepModelOverridesOf(row),
    tasks: c.repos.tasks.list(row.id).map(toTaskDto),
    stepRuns: c.repos.stepRuns.listForProject(row.id).map(toStepRunDto),
    messages: c.repos.messages.list(row.id, 200).map(toMessageDto),
    microRequests: c.repos.micro.list(row.id, 50).map(toMicroDto),
    specGenerating: c.spec.isGenerating(row.id),
  };
}

function mustGet(c: Container, id: string): ProjectRow {
  const row = c.repos.projects.byId(id);
  if (!row) throw notFound('Projet introuvable');
  return row;
}

function emitProject(c: Container, id: string): void {
  const row = c.repos.projects.byId(id);
  if (row) c.bus.emit('project.updated', id, { project: c.repos.projects.summary(row) });
  c.bus.emit('queue.updated', null, c.repos.projects.queueSnapshot());
}

export function registerProjectRoutes(app: FastifyInstance, c: Container): void {
  const sm = new ProjectStateMachine(c.repos.projects);

  app.post('/api/projects', async (req, reply) => {
    const body = CreateZ.parse(req.body);
    let slug = slugify(body.title);
    if (c.repos.projects.slugExists(slug) || c.ws.exists(slug)) {
      let candidate = slug;
      for (let i = 2; i < 100; i++) {
        candidate = `${slug.slice(0, 30)}-${i}`;
        if (!c.repos.projects.slugExists(candidate) && !c.ws.exists(candidate)) break;
      }
      slug = candidate;
    }
    const id = randomUUID();
    const workspacePath = await c.ws.create(slug, body.title);
    if (body.designContent?.trim() || body.designUrl?.trim()) {
      c.ws.writeDesignReference(workspacePath, { content: body.designContent, url: body.designUrl });
      await c.ws.commitAll(workspacePath, 'docs: design reference');
    }
    const row = c.repos.projects.insert({
      id,
      slug,
      title: body.title,
      model: body.model ?? null,
      workspacePath,
      initialPrompt: body.initialPrompt,
    });
    emitProject(c, id);
    void c.chat.runCadrageTurn(id, body.initialPrompt);
    return reply.code(201).send(detail(c, row));
  });

  app.get('/api/projects', async () => {
    return {
      projects: c.repos.projects.all().map((r) => c.repos.projects.summary(r)),
      queue: c.repos.projects.queueSnapshot(),
    };
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    return detail(c, mustGet(c, id));
  });

  /** Per-project preferences (currently: design benchmark toggle; null = follow global setting). */
  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ designBenchmark: z.boolean().nullable() }).parse(req.body);
    mustGet(c, id);
    c.repos.projects.patch(id, { design_benchmark: body.designBenchmark === null ? null : body.designBenchmark ? 1 : 0 });
    emitProject(c, id);
    return detail(c, mustGet(c, id));
  });

  app.post('/api/projects/:id/chat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ChatZ.parse(req.body);
    const row = mustGet(c, id);
    if (row.status === 'draft' || row.status === 'spec_ready') {
      void c.chat.runCadrageTurn(id, body.content);
    } else if (row.status === 'deploying' || row.status === 'deploy_failed') {
      void c.deploy.runTurn(id, body.content);
    } else {
      throw conflict(`Chat indisponible en statut « ${row.status} »`);
    }
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/projects/:id/generate-spec', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status !== 'draft' && row.status !== 'spec_ready') {
      throw conflict(`Génération du SPEC impossible en statut « ${row.status} »`);
    }
    const alreadyRunning = c.spec.isGenerating(id);
    if (!alreadyRunning) void c.spec.generateSpec(id);
    return reply.code(202).send({ accepted: true, alreadyRunning });
  });

  app.post('/api/projects/:id/validate-spec', async (req) => {
    const { id } = req.params as { id: string };
    mustGet(c, id);
    await c.spec.validateSpec(id);
    return { ok: true };
  });

  app.post('/api/projects/:id/pause', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status === 'building') {
      if (!c.scheduler.abortProject(id, 'pause')) {
        sm.transitionOr409(id, ['building'], 'paused_user');
        emitProject(c, id);
      }
    } else if (row.status === 'queued') {
      sm.transitionOr409(id, ['queued'], 'paused_user');
      emitProject(c, id);
    } else {
      throw conflict(`Pause impossible en statut « ${row.status} »`);
    }
    return { ok: true };
  });

  app.post('/api/projects/:id/resume', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status !== 'paused_user' && row.status !== 'interrupted') {
      throw conflict(`Reprise impossible en statut « ${row.status} »`);
    }
    sm.transitionOr409(id, [row.status], 'queued', { enqueued_at: row.enqueued_at ?? Date.now() });
    emitProject(c, id);
    c.scheduler.poke();
    return { ok: true };
  });

  app.post('/api/projects/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status === 'deployed' || row.status === 'canceled') {
      throw conflict('Projet déjà terminé');
    }
    c.scheduler.abortProject(id, 'cancel');
    sm.transitionOr409(id, [row.status], 'canceled');
    emitProject(c, id);
    return { ok: true };
  });

  /** Permanent deletion of a CANCELED project: DB rows + local workspace (the GitHub repo, if any, is untouched). */
  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status !== 'canceled') {
      throw conflict(`Suppression réservée aux projets annulés (statut actuel « ${row.status} »)`);
    }
    await c.appRunner.stop(id);
    // Only wipe the folder when it lives under the workspace root (always true for
    // pj-gen-created workspaces — belt and braces against a corrupted DB path).
    const wsRoot = path.resolve(c.config.workspaceRoot);
    const wsPath = path.resolve(row.workspace_path);
    if (wsPath !== wsRoot && wsPath.startsWith(wsRoot + path.sep)) {
      await fs.promises.rm(wsPath, { recursive: true, force: true });
    }
    c.repos.projects.deleteCascade(id);
    c.bus.emit('project.deleted', id, { id });
    return { ok: true };
  });

  app.post('/api/projects/:id/retry', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustGet(c, id);
    if (row.status === 'failed') {
      sm.transitionOr409(id, ['failed'], 'queued', { error_message: null, enqueued_at: row.enqueued_at ?? Date.now() });
      emitProject(c, id);
      c.scheduler.poke();
    } else if (row.status === 'deploy_failed') {
      sm.transitionOr409(id, ['deploy_failed'], 'awaiting_deploy_approval', { error_message: null });
      emitProject(c, id);
    } else {
      throw conflict(`Réessai impossible en statut « ${row.status} »`);
    }
    return { ok: true };
  });

  /** Reopen a settled project for an improvement iteration (back to cadrage, then the normal queue). */
  app.post('/api/projects/:id/reopen', async (req) => {
    const { id } = req.params as { id: string };
    const body = ReopenZ.parse(req.body);
    mustGet(c, id);
    await c.spec.reopen(id, body.request, { content: body.designContent, url: body.designUrl });
    return { ok: true };
  });

  /** Live micro-modification: one small change → one task → reduced pipeline (no full cycle). */
  app.post('/api/projects/:id/micro', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ request: z.string().min(1).max(4000) }).parse(req.body);
    mustGet(c, id);
    const outcome = await c.micro.create(id, body.request, 'manual');
    return reply.code(202).send(outcome);
  });

  app.post('/api/projects/:id/approve-deploy', async (req) => {
    const { id } = req.params as { id: string };
    const body = ApproveZ.parse(req.body ?? {});
    mustGet(c, id);
    await c.deploy.approve(id, body.notes);
    return { ok: true };
  });

  app.post('/api/projects/:id/mark-deployed', async (req) => {
    const { id } = req.params as { id: string };
    mustGet(c, id);
    await c.deploy.markDeployed(id);
    return { ok: true };
  });
}
