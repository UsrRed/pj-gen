import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Container } from '../../container.js';
import { checkAuth } from '../../claude/capabilities.js';
import { HttpError } from '../../core/httpError.js';

const SizeZ = z.object({
  cols: z.number().int().min(10).max(500),
  rows: z.number().int().min(3).max(300),
});
const InputZ = z.object({ data: z.string().min(1).max(64 * 1024) });

const HEARTBEAT_MS = 15_000;

/**
 * The console is a shell: it must never be drivable from another origin. The global CORS policy
 * reflects any origin (fine for the rest of the API, not for this), and the Aperçu relay serves
 * arbitrary generated apps on the same host, another port — a page there must not reach this.
 * Sec-Fetch-Site / Origin are set by the browser itself and cannot be forged by page scripts.
 * Requests with neither header are not from a browser page (curl, tests) and pass.
 */
export function assertSameOrigin(req: FastifyRequest): void {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Console : requête inter-origine refusée');
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Console : origine invalide');
    }
    const allowed = [req.headers.host, req.headers['x-forwarded-host']].filter((h): h is string => typeof h === 'string');
    if (!allowed.includes(host)) throw new HttpError(403, 'Console : requête inter-origine refusée');
  } else if (origin === 'null') {
    throw new HttpError(403, 'Console : origine opaque refusée');
  }
}

/** Exposed on the LAN, pj-gen has no authentication of its own: a shell there would be open to anyone. */
function assertNotOnLan(c: Container): void {
  if (c.lan.status().enabled) {
    throw new HttpError(403, "Console désactivée tant que pj-gen est exposé sur le réseau local (Réglages) — aucune authentification ne la protégerait");
  }
}

export function registerConsoleRoutes(app: FastifyInstance, c: Container): void {
  const guard = (req: FastifyRequest) => {
    assertSameOrigin(req);
    assertNotOnLan(c);
  };

  app.get('/api/console', async (req) => {
    guard(req);
    return c.console.status();
  });

  app.post('/api/console/start', async (req) => {
    guard(req);
    const { cols, rows } = SizeZ.parse(req.body);
    return c.console.start(cols, rows);
  });

  app.post('/api/console/input', async (req) => {
    guard(req);
    c.console.write(InputZ.parse(req.body).data);
    return { ok: true };
  });

  app.post('/api/console/resize', async (req) => {
    guard(req);
    const { cols, rows } = SizeZ.parse(req.body);
    c.console.resize(cols, rows);
    return { ok: true };
  });

  app.post('/api/console/kill', async (req) => {
    guard(req);
    c.console.kill();
    return { ok: true };
  });

  /** After a `claude auth login` in the console: refresh pj-gen's view without a restart. */
  app.post('/api/console/recheck-auth', async (req) => {
    guard(req);
    const auth = c.config.fakeCli ? { ok: true, detail: 'simulation', checkedAt: Date.now() } : await checkAuth(c.config.claudeBin);
    c.scheduler.setAuth(auth);
    return auth;
  });

  /**
   * SSE: `snapshot` (scrollback + status) on every (re)connect, then `output` chunks, `started`
   * and `exit`. SSE rather than WebSocket: it already crosses `tailscale serve` (HTTP/2) for the
   * main event stream, where an Upgrade handshake is not guaranteed to.
   */
  app.get('/api/console/stream', (req: FastifyRequest, reply: FastifyReply) => {
    guard(req);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: string, payload: unknown) => {
      try {
        raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        /* connection dying; close handler cleans up */
      }
    };
    send('snapshot', { data: c.console.snapshot(), status: c.console.status() });
    const unsubscribe = c.console.subscribe((e) => {
      if (e.type === 'output') send('output', e.data);
      else send(e.type, e.status);
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
  });
}
