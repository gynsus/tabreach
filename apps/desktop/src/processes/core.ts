// Entry point of the core utility process (ADR 012). Wires Electron's parentPort to CoreService.
import type { MessagePortMain } from 'electron';
import { CoreService } from '@tabreach/core';
import { createLogger } from '../shared/logger';
import {
  RESTART_EXIT_CODE,
  parentPortEndpoint,
  portEndpoint,
  readChildEnv,
  type PortHandoff,
} from '../shared/ipc';

const env = readChildEnv(process.env);
const logger = createLogger({
  process: 'core',
  logDir: env.TABREACH_LOG_DIR,
  stdout: env.TABREACH_DEV === '1',
});

let core: CoreService | null = null;
// Ports queue their messages until started, so handoffs that arrive during startup are kept.
const early: Array<[PortHandoff, MessagePortMain]> = [];

function attach(handoff: PortHandoff, port: MessagePortMain): void {
  if (!core) {
    early.push([handoff, port]);
    return;
  }
  const endpoint = portEndpoint(port);
  if (handoff.name === 'app') {
    const detach = core.attachApp(endpoint);
    port.on('close', detach);
  } else {
    const detach = core.attachWorker(endpoint);
    port.on('close', detach);
  }
  logger.info({ event: 'ipc.port_attached', name: handoff.name }, 'channel attached');
}

const host = parentPortEndpoint(process.parentPort, attach);

CoreService.start({
  dataDir: env.TABREACH_DATA_DIR,
  appVersion: env.TABREACH_APP_VERSION,
  electronVersion: process.versions.electron ?? null,
  host,
  logger,
  logDir: env.TABREACH_LOG_DIR,
  restart: () => {
    logger.info({ event: 'core.restarting' }, 'core restarting');
    core?.close();
    process.exit(RESTART_EXIT_CODE);
  },
}).then(
  (started) => {
    core = started;
    for (const [handoff, port] of early.splice(0)) attach(handoff, port);
    logger.info({ event: 'core.started' }, 'core started');
  },
  (error: unknown) => {
    logger.error({ event: 'core.start_failed', err: error }, 'core failed to start');
    // Exit non-zero so the supervisor in main sees the failure and applies its restart policy.
    setTimeout(() => process.exit(1), 100);
  },
);

// main stops core with SIGTERM on quit: close the database cleanly (checkpoints the WAL).
process.on('SIGTERM', () => {
  logger.info({ event: 'core.stopping' }, 'core stopping');
  core?.close();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  logger.error({ event: 'core.uncaught_exception', err: error }, 'uncaught exception');
  setTimeout(() => process.exit(1), 100);
});
