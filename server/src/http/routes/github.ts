import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { GithubRepoView } from '@pjgen/shared';
import type { Container } from '../../container.js';
import { notFound } from '../../core/httpError.js';
import { toIssueDto } from '../../db/repos/index.js';

const CONCURRENT_SYNCS = 4;

export function registerGithubRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/github/status', async (req) => {
    const q = req.query as { force?: string };
    return c.github.status(q.force === '1');
  });

  /** The /github view: remote repos × local projects, three categories. */
  app.get('/api/github/repos', async () => {
    const status = await c.github.status();
    if (!status.authOk) return { status, repos: [] as GithubRepoView[] };

    const locals = c.repos.projects.all();
    const byRepo = new Map(locals.filter((p) => p.github_repo).map((p) => [p.github_repo!, p]));
    const bySlug = new Map(locals.map((p) => [p.slug, p]));
    const views: GithubRepoView[] = [];
    const remote = await c.github.listRemoteRepos();

    const linked = remote.filter((r) => byRepo.has(r.nameWithOwner) || bySlug.get(r.name)?.github_repo === r.nameWithOwner);
    // Bounded-parallel sync states for linked repos only.
    const syncs = new Map<string, { ahead: number | null; behind: number | null }>();
    for (let i = 0; i < linked.length; i += CONCURRENT_SYNCS) {
      await Promise.all(
        linked.slice(i, i + CONCURRENT_SYNCS).map(async (r) => {
          const p = byRepo.get(r.nameWithOwner)!;
          syncs.set(r.nameWithOwner, await c.github.syncState(p));
        })
      );
    }

    for (const r of remote) {
      const p = byRepo.get(r.nameWithOwner);
      if (p) {
        const s = syncs.get(r.nameWithOwner);
        views.push({
          category: 'linked',
          projectId: p.id,
          slug: p.slug,
          title: p.title,
          projectStatus: p.status,
          nameWithOwner: r.nameWithOwner,
          visibility: r.visibility,
          updatedAt: r.updatedAt,
          url: r.url,
          ahead: s?.ahead ?? null,
          behind: s?.behind ?? null,
          autoMode: p.github_auto_mode === 1,
        });
      } else {
        views.push({
          category: 'remote_only',
          nameWithOwner: r.nameWithOwner,
          visibility: r.visibility,
          updatedAt: r.updatedAt,
          url: r.url,
        });
      }
    }
    for (const p of locals) {
      if (!p.github_repo) {
        views.push({ category: 'local_unpublished', projectId: p.id, slug: p.slug, title: p.title, projectStatus: p.status });
      }
    }
    return { status, repos: views };
  });

  /** Clone a remote-only repo into the workspace and register it as a (deployed) project. */
  app.post('/api/github/clone', async (req, reply) => {
    const body = z.object({ nameWithOwner: z.string().min(3).max(200) }).parse(req.body);
    const row = await c.github.cloneRepo(body.nameWithOwner);
    return reply.code(201).send(c.repos.projects.summary(row));
  });

  app.post('/api/projects/:id/github/link', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ private: z.boolean().optional() }).parse(req.body ?? {});
    const row = await c.github.linkProject(id, { private: body.private });
    return c.repos.projects.summary(row);
  });

  app.post('/api/projects/:id/github/push', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ message: z.string().max(500).optional() }).parse(req.body ?? {});
    const row = await c.github.push(id, body.message);
    return c.repos.projects.summary(row);
  });

  app.post('/api/projects/:id/github/generate-ci', async (req) => {
    const { id } = req.params as { id: string };
    await c.github.generateCi(id);
    return { ok: true };
  });

  app.patch('/api/projects/:id/github/auto-mode', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const row = c.github.setAutoMode(id, body.enabled);
    return c.repos.projects.summary(row);
  });

  // ---------- issues ----------

  app.get('/api/issues', async (req) => {
    const q = req.query as { projectId?: string };
    if (q.projectId) {
      if (!c.repos.projects.byId(q.projectId)) throw notFound('Projet introuvable');
      return { issues: c.repos.issues.list(q.projectId).map(toIssueDto) };
    }
    return { issues: c.repos.issues.listAll().map(toIssueDto) };
  });

  app.post('/api/issues/:id/decision', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ decision: z.enum(['skipped', 'queued']) }).parse(req.body);
    const issue = c.repos.issues.byId(Number(id));
    if (!issue) throw notFound('Issue introuvable');
    const updated = c.repos.issues.patch(issue.id, { decision: body.decision });
    c.bus.emit('issue.updated', issue.project_id, { issue: toIssueDto(updated) });
    if (body.decision === 'queued') c.issuePoller.poke();
    return toIssueDto(updated);
  });

  app.get('/api/github/trusted-users', async () => ({ users: c.repos.issues.trustedUsers() }));

  app.post('/api/github/trusted-users', async (req) => {
    const body = z.object({ login: z.string().min(1).max(100) }).parse(req.body);
    c.repos.issues.addTrustedUser(body.login.trim());
    return { users: c.repos.issues.trustedUsers() };
  });

  app.delete('/api/github/trusted-users/:login', async (req) => {
    const { login } = req.params as { login: string };
    c.repos.issues.removeTrustedUser(login);
    return { users: c.repos.issues.trustedUsers() };
  });
}
