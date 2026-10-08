import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { UpdateStatusDto } from '@pjgen/shared';
import type { Container } from '../../container.js';
import { assertSameOrigin } from './console.js';

/**
 * Barrière de la mise à jour automatique (infra-suivi sur l'hôte, voir projects/pj-gen/suivi-garde
 * dans le dépôt infra). Le fichier `update-armed` du volume de données contient l'epoch (s) de
 * l'armement. L'hôte ne déploie un nouveau commit que si il est présent et plus jeune que
 * UPDATE_ARM_TTL_S, puis le SUPPRIME avant de déployer : sans nouveau clic, la barrière est
 * fermée. Même TTL côté hôte (suivi-garde) — à garder synchrone.
 */
export const UPDATE_ARM_TTL_S = 30 * 60;
const BUSY = ['building', 'deploying'];

function armedFile(c: Container): string {
  return path.join(c.config.dataDir, 'update-armed');
}

function readArmedAt(c: Container): number | null {
  try {
    const t = Number(fs.readFileSync(armedFile(c), 'utf8').trim());
    if (!Number.isFinite(t) || t <= 0) return null;
    return Date.now() / 1000 - t < UPDATE_ARM_TTL_S ? t : null;
  } catch {
    return null;
  }
}

export function updateStatus(c: Container): UpdateStatusDto {
  const at = readArmedAt(c);
  return {
    armed: at !== null,
    armedAt: at !== null ? at * 1000 : null,
    expiresAt: at !== null ? (at + UPDATE_ARM_TTL_S) * 1000 : null,
    busyProjects: c.repos.projects
      .all()
      .filter((p) => BUSY.includes(p.status))
      .map((p) => p.title),
  };
}

export function registerUpdateRoutes(app: FastifyInstance, c: Container): void {
  app.get('/api/update', async () => updateStatus(c));

  app.post('/api/update/arm', async (req) => {
    assertSameOrigin(req);
    fs.writeFileSync(armedFile(c), `${Math.floor(Date.now() / 1000)}\n`);
    return updateStatus(c);
  });

  app.post('/api/update/disarm', async (req) => {
    assertSameOrigin(req);
    fs.rmSync(armedFile(c), { force: true });
    return updateStatus(c);
  });
}
