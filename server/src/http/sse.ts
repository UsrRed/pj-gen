import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../container.js';

const HEARTBEAT_MS = 15_000;

function writeEvent(raw: NodeJS.WritableStream, id: number, type: string, projectId: string | null, payload: unknown): void {
  raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify({ projectId, payload })}\n\n`);
}

function handleSse(c: Container, projectId: string | null) {
  return (req: FastifyRequest, reply: FastifyReply): void => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': (req.headers.origin as string) ?? '*',
    });
    raw.write(': connected\n\n');

    const lastIdHeader = req.headers['last-event-id'];
    const lastIdQuery = (req.query as Record<string, string | undefined>)?.lastEventId;
    const lastId = Number(Array.isArray(lastIdHeader) ? lastIdHeader[0] : (lastIdHeader ?? lastIdQuery ?? 0)) || 0;

    // Replay ONLY fills reconnection gaps (native EventSource resends Last-Event-ID).
    // A fresh connect (lastId=0) starts live: initial state comes from REST — replaying the whole
    // history would overwrite fresh data with stale payloads recorded under older DTO shapes.
    for (const row of lastId > 0 ? c.repos.events.listAfter(lastId, projectId) : []) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        payload = null;
      }
      writeEvent(raw, row.id, row.type, row.project_id, payload);
    }

    const unsubscribe = c.bus.subscribe({
      projectId,
      fn: (id, type, evtProjectId, payload) => {
        try {
          writeEvent(raw, id, type, evtProjectId, payload);
        } catch {
          /* connection dying; close handler cleans up */
        }
      },
    });

    const heartbeat = setInterval(() => {
      try {
        raw.write(`: hb ${Date.now()}\n\n`);
      } catch {
        /* ignored */
      }
    }, HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        raw.end();
      } catch {
        /* ignored */
      }
    });
  };
}

export function registerSse(app: FastifyInstance, c: Container): void {
  app.get('/api/events', handleSse(c, null));
  app.get('/api/projects/:id/events', (req, reply) => {
    const { id } = req.params as { id: string };
    handleSse(c, id)(req, reply);
  });
}
