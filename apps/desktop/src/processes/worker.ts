// Entry point of the browser worker utility process (ADR 012). The worker package itself only
// sees a MessageEndpoint, so the host process type can change without touching worker logic.
import { BrowserWorker } from '@tabreach/browser-worker';
import { createLogger } from '../shared/logger';
import { parentPortEndpoint, portEndpoint, readChildEnv } from '../shared/ipc';

const env = readChildEnv(process.env);
const logger = createLogger({
  process: 'worker',
  logDir: env.TABREACH_LOG_DIR,
  stdout: env.TABREACH_DEV === '1',
});

let worker: BrowserWorker | null = null;

parentPortEndpoint(process.parentPort, (handoff, port) => {
  if (handoff.name !== 'browser') {
    logger.warn({ event: 'ipc.unexpected_port', name: handoff.name }, 'ignored port');
    return;
  }
  // A new core connection replaces the old one (core restarted).
  worker?.close();
  worker = new BrowserWorker({ core: portEndpoint(port), logger });
  logger.info({ event: 'ipc.port_attached', name: handoff.name }, 'connected to core');
});

process.on('uncaughtException', (error) => {
  logger.error({ event: 'worker.uncaught_exception', err: error }, 'uncaught exception');
  setTimeout(() => process.exit(1), 100);
});

logger.info({ event: 'worker.started' }, 'worker started');
