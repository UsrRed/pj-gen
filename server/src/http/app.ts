import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Container } from '../container.js';
import { HttpError } from '../core/httpError.js';
import { registerSse } from './sse.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerControlRoutes } from './routes/control.js';
import { registerGithubRoutes } from './routes/github.js';
import { registerAccessRoutes } from './routes/access.js';
import { registerConsoleRoutes } from './routes/console.js';
import { registerUpdateRoutes } from './routes/update.js';

export async function createApp(c: Container): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2_000_000 });

  await app.register(cors, { origin: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    if (err instanceof ZodError) {
      const detail = err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Requête invalide — ${detail}` });
    }
    // eslint-disable-next-line no-console
    console.error('[pj-gen] erreur route', req.method, req.url, err);
    return reply.code(500).send({ error: 'Erreur interne' });
  });

  registerSse(app, c);
  registerProjectRoutes(app, c);
  registerMiscRoutes(app, c);
  registerControlRoutes(app, c);
  registerGithubRoutes(app, c);
  registerAccessRoutes(app, c);
  registerConsoleRoutes(app, c);
  registerUpdateRoutes(app, c);

  const webDist = c.config.webDist;
  const hasWeb = fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Introuvable' });
  });

  return app;
}
