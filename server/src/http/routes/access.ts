import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ACCESS_KINDS, ACCESS_STATUSES } from '@pjgen/shared';
import type { Container } from '../../container.js';
import { badRequest, notFound } from '../../core/httpError.js';
import { toAccessDto } from '../../db/repos/index.js';
import { ENV_NAME_RE, readEnvKeys, writeEnv } from '../../access/envFile.js';
import { runAccessTest, TESTABLE_KINDS } from '../../access/accessTest.js';

const UpsertZ = z.object({
  key: z.string().min(1).max(64),
  kind: z.enum(ACCESS_KINDS),
  label: z.string().min(1).max(160),
  required: z.boolean().default(true),
  why: z.string().max(600).default(''),
  secretEnvVars: z.array(z.string().max(64)).max(12).default([]),
});

const PatchZ = z.object({
  fields: z.record(z.string().max(256)).optional(),
  status: z.enum(ACCESS_STATUSES).optional(),
});

/** Secret values: written straight to the workspace .env, never stored, never returned. */
const SecretsZ = z.object({ values: z.record(z.string().max(4000)) });

export function registerAccessRoutes(app: FastifyInstance, c: Container): void {
  const mustProject = (id: string) => {
    const row = c.repos.projects.byId(id);
    if (!row) throw notFound('Projet introuvable');
    return row;
  };

  const emit = (projectId: string) => {
    c.bus.emit('access.updated', projectId, { items: c.repos.access.list(projectId).map(toAccessDto) });
  };

  app.get('/api/projects/:id/access', async (req) => {
    const { id } = req.params as { id: string };
    const row = mustProject(id);
    return {
      items: c.repos.access.list(id).map(toAccessDto),
      // Names only — the .env values are never read back out through the API.
      secretsPresent: readEnvKeys(row.workspace_path),
    };
  });

  app.post('/api/projects/:id/access', async (req, reply) => {
    const { id } = req.params as { id: string };
    mustProject(id);
    const body = UpsertZ.parse(req.body);
    try {
      c.repos.access.upsertManual(id, body);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    emit(id);
    return reply.code(201).send({ items: c.repos.access.list(id).map(toAccessDto) });
  });

  app.patch('/api/projects/:id/access/:accessId', async (req) => {
    const { id, accessId } = req.params as { id: string; accessId: string };
    mustProject(id);
    const body = PatchZ.parse(req.body);
    const numId = Number(accessId);
    if (!c.repos.access.byId(id, numId)) throw notFound('Accès introuvable');
    try {
      if (body.fields) c.repos.access.patchFields(id, numId, body.fields);
      if (body.status) c.repos.access.setStatus(id, numId, body.status);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    emit(id);
    return { item: toAccessDto(c.repos.access.byId(id, numId)!) };
  });

  app.delete('/api/projects/:id/access/:accessId', async (req) => {
    const { id, accessId } = req.params as { id: string; accessId: string };
    mustProject(id);
    c.repos.access.remove(id, Number(accessId));
    emit(id);
    return { ok: true };
  });

  /**
   * The ONLY route that handles a secret value. It writes it to `<workspace>/.env`
   * (0600, gitignored) and returns names only — nothing is stored in SQLite, nothing
   * is echoed back, and Fastify runs with `logger: false` so no body is journalled.
   */
  app.post('/api/projects/:id/access/:accessId/secrets', async (req) => {
    const { id, accessId } = req.params as { id: string; accessId: string };
    const project = mustProject(id);
    const row = c.repos.access.byId(id, Number(accessId));
    if (!row) throw notFound('Accès introuvable');
    const body = SecretsZ.parse(req.body);

    const allowed = new Set(JSON.parse(row.secret_env_vars) as string[]);
    const names = Object.keys(body.values);
    if (!names.length) throw badRequest('aucune variable fournie');
    for (const name of names) {
      if (!ENV_NAME_RE.test(name)) throw badRequest(`nom de variable invalide: ${name}`);
      // Whitelist: prevents writing arbitrary environment variables into the workspace.
      if (!allowed.has(name)) throw badRequest(`variable « ${name} » non déclarée par cet accès`);
    }

    let written: string[];
    try {
      written = writeEnv(project.workspace_path, body.values);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    c.repos.access.setStatus(id, row.id, 'provided');
    emit(id);
    return { ok: true, written };
  });

  app.post('/api/projects/:id/access/:accessId/test', async (req) => {
    const { id, accessId } = req.params as { id: string; accessId: string };
    mustProject(id);
    const row = c.repos.access.byId(id, Number(accessId));
    if (!row) throw notFound('Accès introuvable');
    if (!TESTABLE_KINDS.includes(row.kind)) throw badRequest('aucun test disponible pour ce type d’accès');

    const fields = JSON.parse(row.fields) as Record<string, string>;
    const outcome = await runAccessTest(row.kind, fields);
    c.repos.access.recordTest(id, row.id, outcome.ok, outcome.detail);
    emit(id);
    return { ...outcome, at: Date.now() };
  });
}
