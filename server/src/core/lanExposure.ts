import net from 'node:net';
import os from 'node:os';
import type { LanStatusDto } from '@pjgen/shared';

/** Non-internal IPv4 addresses of this machine (the LAN-facing interfaces). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const LOOPBACKS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Runtime-toggleable LAN exposure: the Fastify server stays bound to loopback; when enabled,
 * a raw TCP proxy binds the same port on each LAN interface and pipes sockets to loopback.
 * Rebinding the main server would require killing every live SSE connection — this doesn't.
 */
export class LanExposure {
  private servers: net.Server[] = [];
  private sockets = new Set<net.Socket>();
  private urls: string[] = [];
  private errors: string[] = [];
  private enabled = false;

  constructor(
    private port: number,
    private serverHost: string
  ) {}

  private get alreadyExposed(): boolean {
    return !LOOPBACKS.has(this.serverHost);
  }

  status(): LanStatusDto {
    return {
      enabled: this.enabled || this.alreadyExposed,
      urls: this.alreadyExposed ? lanAddresses().map((a) => `http://${a}:${this.port}`) : [...this.urls],
      errors: [...this.errors],
      alreadyExposed: this.alreadyExposed,
    };
  }

  /** Idempotent: re-applies the desired state (re-enumerates interfaces on each enable). */
  async apply(enabled: boolean, addresses?: string[]): Promise<LanStatusDto> {
    await this.disable();
    if (enabled && !this.alreadyExposed) await this.enable(addresses ?? lanAddresses());
    return this.status();
  }

  private async enable(addresses: string[]): Promise<void> {
    this.enabled = true;
    this.errors = addresses.length ? [] : ['aucune interface réseau locale détectée'];
    for (const address of addresses) {
      await new Promise<void>((resolve) => {
        const server = net.createServer((socket) => {
          const upstream = net.connect(this.port, this.serverHost);
          this.sockets.add(socket);
          const drop = () => {
            this.sockets.delete(socket);
            socket.destroy();
            upstream.destroy();
          };
          socket.on('error', drop).on('close', drop);
          upstream.on('error', drop).on('close', drop);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        server.on('error', (err) => {
          this.errors.push(`${address}: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
          resolve();
        });
        server.listen(this.port, address, () => {
          this.servers.push(server);
          this.urls.push(`http://${address}:${this.port}`);
          resolve();
        });
      });
    }
  }

  async disable(): Promise<void> {
    this.enabled = false;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          })
      )
    );
    this.servers = [];
    this.urls = [];
    this.errors = [];
  }
}
