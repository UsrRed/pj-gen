import { loadConfig } from './config.js';
import { acquireLock } from './core/lockfile.js';
import { buildContainer } from './container.js';
import { createApp } from './http/app.js';
import { checkAuth } from './claude/capabilities.js';
import { recoverOnBoot } from './pipeline/recovery.js';

const AUTH_RECHECK_MS = 6 * 60 * 60 * 1000;

async function main(): Promise<void> {
  // Rewrites /proc/<pid>/cmdline: a build agent's pattern-kill (pkill -f tsx / src/index.ts)
  // must not match the orchestrator. Second layer after the kill-guard hook.
  process.title = 'pj-gen-server';
  const config = loadConfig();
  const releaseLock = acquireLock(config.dataDir);
  const c = await buildContainer(config);

  if (!c.caps.ok) {
    c.bus.emit('boot.notice', null, { level: 'error', message: `CLI claude indisponible: ${c.caps.versionWarning ?? ''}` });
  } else if (c.caps.versionWarning) {
    c.bus.emit('boot.notice', null, { level: 'warn', message: c.caps.versionWarning });
  }

  const auth = config.fakeCli ? { ok: true, detail: 'simulation', checkedAt: Date.now() } : await checkAuth(config.claudeBin);
  c.scheduler.setAuth(auth);
  const authTimer = setInterval(async () => {
    if (!config.fakeCli) c.scheduler.setAuth(await checkAuth(config.claudeBin));
  }, AUTH_RECHECK_MS);

  recoverOnBoot(c);
  c.scheduler.start();
  c.issuePoller.start();

  const app = await createApp(c);
  await app.listen({ port: config.port, host: config.host });
  const lanStatus = await c.lan.apply(c.repos.settings.getAll().exposeLan);

  // eslint-disable-next-line no-console
  console.log(
    [
      '',
      `  pj-gen démarré — http://${config.host}:${config.port}`,
      `  réseau local: ${lanStatus.enabled ? lanStatus.urls.join(', ') || 'activé (aucune interface)' : 'désactivé (loopback seul)'}`,
      `  mode: ${config.fakeCli ? 'SIMULATION (aucun appel claude réel)' : `réel (claude ${c.caps.version})`}`,
      `  auth: ${auth.ok ? 'OK' : `KO — ${auth.detail}`}`,
      `  workspaces: ${config.workspaceRoot}`,
      '',
    ].join('\n')
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`\n[pj-gen] arrêt (${signal})…`);
    clearInterval(authTimer);
    try {
      await app.close();
    } catch {
      /* ignored */
    }
    c.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error('[pj-gen] unhandledRejection', reason);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[pj-gen] échec du démarrage:', err.message ?? err);
  process.exit(1);
});
