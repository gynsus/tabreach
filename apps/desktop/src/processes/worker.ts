// Entry point of the browser worker utility process (ADR 012). The worker package itself only
// sees a MessageEndpoint, so the host process type can change without touching worker logic.
import { join } from 'node:path';
import { BrowserWorker, ProfileManager, sweepStaleProfiles } from '@tabreach/browser-worker';
import { createLogger } from '../shared/logger';
import { parentPortEndpoint, portEndpoint, readChildEnv } from '../shared/ipc';

const env = readChildEnv(process.env);
const logger = createLogger({
  process: 'worker',
  logDir: env.TABREACH_LOG_DIR,
  stdout: env.TABREACH_DEV === '1',
});

let worker: BrowserWorker | null = null;
// One set of running profiles for the life of the process: Chrome windows outlive a core restart.
const profiles = new ProfileManager({ root: join(env.TABREACH_DATA_DIR, 'profiles'), logger });

parentPortEndpoint(process.parentPort, (handoff, port) => {
  if (handoff.name !== 'browser') {
    logger.warn({ event: 'ipc.unexpected_port', name: handoff.name }, 'ignored port');
    return;
  }
  // A new core connection replaces the old one (core restarted).
  worker?.close();
  worker = new BrowserWorker({
    core: portEndpoint(port),
    logger,
    profiles,
    tasks: { diagnosticsDir: join(env.TABREACH_DATA_DIR, 'diagnostics') },
  });
  logger.info({ event: 'ipc.port_attached', name: handoff.name }, 'connected to core');
});

// Asked to stop (app quit): close Chrome cleanly so profiles are not left locked.
process.on('SIGTERM', () => {
  void profiles.closeAll().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  logger.error({ event: 'worker.uncaught_exception', err: error }, 'uncaught exception');
  setTimeout(() => process.exit(1), 100);
});

logger.info({ event: 'worker.started' }, 'worker started');

sweepStaleProfiles().then(
  (count) => {
    if (count > 0)
      logger.info({ event: 'worker.stale_profiles_removed', count }, 'removed leftover temp profiles');
  },
  (error: unknown) =>
    logger.warn({ event: 'worker.sweep_failed', err: error }, 'could not sweep temp profiles'),
);
