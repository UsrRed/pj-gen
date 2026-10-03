import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AppRunner } from './appRunner.js';

/**
 * Aperçu distant: a second HTTP listener that relays to a preview's dev server (or any local
 * port), so a project started from the Aperçu tab can be opened from another machine through
 * the same entry point as pj-gen itself (e.g. a tailnet port), without reaching the dev server's
 * own port.
 *
 * Why a dedicated listener instead of a path prefix under pj-gen: dev servers (Vite…) emit
 * absolute paths (/@vite/client, /src/main.tsx, /api/…) that a /preview/<id>/ prefix would
 * break. Here the whole origin belongs to the previewed app; the target is chosen once via
 * /__pjgen/preview/<projectId> (follows that project's running app) or /__pjgen/port/<n>, and
 * remembered in a cookie. Cookies ignore ports, so two tabs on two different previews share it:
 * the last selection wins.
 */

const COOKIE = 'pjgen_preview';

/**
 * Every upstream is a loopback dev server, but which loopback depends on the tool: Vite 5 binds
 * `localhost` to ::1 only, while Node's own lookup of `localhost` (AI_ADDRCONFIG, no global IPv6
 * in a container) yields 127.0.0.1 only — ECONNREFUSED although the server is up. Offer both and
 * let autoSelectFamily try them in turn.
 */
const loopbackLookup: net.LookupFunction = (_hostname, options, callback) => {
  const all = [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];
  if ((options as { all?: boolean }).all) (callback as unknown as (e: null, a: typeof all) => void)(null, all);
  else callback(null, all[0].address, all[0].family);
};
const CTRL = '/__pjgen';

type Target = { kind: 'project'; projectId: string } | { kind: 'port'; port: number };

interface Upstream {
  host: string;
  port: number;
}

export interface PreviewProxyOptions {
  host: string;
  port: number;
  /** Ports never relayed by /__pjgen/port/<n> (the proxy itself). */
  deniedPorts?: number[];
}

export class PreviewProxy {
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket | Duplex>();

  constructor(
    private appRunner: AppRunner,
    private opts: PreviewProxyOptions
  ) {}

  /** Actual bound port (differs from opts.port when 0 was requested). */
  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.once('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ---------- routing ----------

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '/';
    if (url === CTRL || url.startsWith(`${CTRL}/`)) {
      this.onControl(url, res);
      return;
    }
    const target = readTarget(req.headers.cookie);
    const upstream = target ? this.resolve(target) : null;
    if (!upstream) {
      page(res, 503, target ? 'L’application de ce projet ne tourne pas (ou son URL n’est pas encore détectée).' : 'Aucun aperçu sélectionné.', this.listing());
      return;
    }

    // autoSelectFamily is handed to net.connect by the agent; RequestOptions just doesn't type it.
    const options: http.RequestOptions & { autoSelectFamily: boolean } = {
      host: 'localhost',
      port: upstream.port,
      lookup: loopbackLookup,
      autoSelectFamily: true,
      method: req.method,
      path: url,
      headers: forwardHeaders(req, upstream),
    };
    const proxyReq = http.request(
      options,
      (proxyRes) => {
        const headers = { ...proxyRes.headers };
        if (typeof headers.location === 'string') headers.location = relativeLocation(headers.location, upstream);
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.statusMessage, headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      page(res, 502, `Le serveur de l’aperçu ne répond pas sur le port ${upstream.port} (${err.message}).`, this.listing());
    });
    req.pipe(proxyReq);
  }

  private onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const target = readTarget(req.headers.cookie);
    const upstream = target ? this.resolve(target) : null;
    if (!upstream) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const up = net.connect({ host: 'localhost', port: upstream.port, lookup: loopbackLookup, autoSelectFamily: true });
    this.sockets.add(up);
    up.once('close', () => this.sockets.delete(up));
    up.on('connect', () => {
      const headers = forwardHeaders(req, upstream);
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) {
        if (v === undefined) continue;
        for (const one of Array.isArray(v) ? v : [v]) raw += `${k}: ${one}\r\n`;
      }
      up.write(`${raw}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const drop = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', drop);
    socket.on('error', drop);
  }

  private onControl(url: string, res: http.ServerResponse): void {
    const pathOnly = url.split('?')[0];
    const project = /^\/__pjgen\/preview\/([\w-]{1,100})\/?$/.exec(pathOnly);
    if (project) {
      select(res, `p:${project[1]}`);
      return;
    }
    const port = /^\/__pjgen\/port\/(\d{1,5})\/?$/.exec(pathOnly);
    if (port) {
      const n = Number(port[1]);
      if (!validPort(n) || n === this.port || this.opts.deniedPorts?.includes(n)) {
        page(res, 400, `Port refusé : ${port[1]}.`, this.listing());
        return;
      }
      select(res, `port:${n}`);
      return;
    }
    page(res, 200, null, this.listing());
  }

  private resolve(target: Target): Upstream | null {
    if (target.kind === 'port') {
      if (target.port === this.port || this.opts.deniedPorts?.includes(target.port)) return null;
      return { host: 'localhost', port: target.port };
    }
    const url = this.appRunner.state(target.projectId).url;
    if (!url) return null;
    try {
      const u = new URL(url);
      const p = Number(u.port || 80);
      return validPort(p) ? { host: u.hostname === '[::1]' ? 'localhost' : u.hostname, port: p } : null;
    } catch {
      return null;
    }
  }

  private listing(): string {
    const running = this.appRunner.runningApps();
    const items = running.length
      ? running
          .map(
            (a) =>
              `<li><a href="${CTRL}/preview/${encodeURIComponent(a.projectId)}">${escapeHtml(a.title)}</a> — ` +
              `<code>${escapeHtml(a.url ?? 'URL pas encore détectée')}</code></li>`
          )
          .join('')
      : '<li>Aucune application lancée depuis l’onglet Aperçu.</li>';
    return (
      `<h2>Aperçus en cours</h2><ul>${items}</ul>` +
      `<h2>Autre port local</h2><form onsubmit="location.href='${CTRL}/port/'+this.p.value;return false">` +
      `<input name="p" type="number" min="1" max="65535" placeholder="5173" required> <button>Ouvrir</button></form>`
    );
  }
}

// ---------- helpers ----------

function validPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function readTarget(cookieHeader: string | undefined): Target | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k !== COOKIE) continue;
    const v = decodeURIComponent(rest.join('='));
    if (v.startsWith('p:') && /^[\w-]{1,100}$/.test(v.slice(2))) return { kind: 'project', projectId: v.slice(2) };
    if (v.startsWith('port:')) {
      const n = Number(v.slice(5));
      if (validPort(n)) return { kind: 'port', port: n };
    }
  }
  return null;
}

/** Strip our own cookie, and present the request as if it came to the dev server directly. */
function forwardHeaders(req: http.IncomingMessage, upstream: Upstream): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  const local = `${upstream.host}:${upstream.port}`;
  // Vite ≥5.4.12 rejects unknown Host headers (server.allowedHosts) — the tailnet name is one.
  headers['x-forwarded-host'] = req.headers.host;
  headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  headers.host = local;
  if (headers.origin) headers.origin = `http://${local}`;
  if (typeof headers.cookie === 'string') {
    const kept = headers.cookie
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${COOKIE}=`));
    if (kept.length) headers.cookie = kept.join('; ');
    else delete headers.cookie;
  }
  return headers;
}

/** An absolute redirect to the dev server itself would leave the proxy: keep it relative. */
function relativeLocation(location: string, upstream: Upstream): string {
  try {
    const u = new URL(location);
    const local = ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(u.hostname);
    if (local && Number(u.port || 80) === upstream.port) return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    /* already relative */
  }
  return location;
}

function select(res: http.ServerResponse, value: string): void {
  res.writeHead(302, {
    location: '/',
    'set-cookie': `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`,
    'cache-control': 'no-store',
  });
  res.end();
}

function page(res: http.ServerResponse, status: number, message: string | null, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>pj-gen — aperçu</title><style>body{font:15px system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;` +
      `color:#e4e4e7;background:#18181b}a{color:#a5b4fc}code{color:#a1a1aa}.msg{color:#fca5a5}</style>` +
      `<h1>pj-gen — aperçu</h1>${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}${body}`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
