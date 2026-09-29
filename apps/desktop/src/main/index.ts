import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
  type UtilityProcess,
} from 'electron';
import { RpcError, RpcPeer, type CoreState, type Logger } from '@tabreach/protocol';
import { createLogger } from '../shared/logger';
import { utilityProcessEndpoint, type ChildEnv, type PortHandoff } from '../shared/ipc';
import { installMenu } from './menu';
import { runLoopback } from './oauth-loopback';
import { registerSaveFile } from './save-file';
import { parseSelfCheck, runSelfCheck } from './self-check';
import { killOrphanChrome } from './orphan-chrome';
import { Supervised } from './supervisor';

const isDev = !app.isPackaged;
if (isDev) {
  // Keep development data away from a real installation; tests point this at a temp dir.
  app.setPath('userData', process.env.TABREACH_USER_DATA_DIR ?? join(app.getPath('appData'), 'TabReach-dev'));
}

/** A self-check that cannot finish within this bound fails instead of hanging CI. */
const SELF_CHECK_DEADLINE_MS = 120_000;

function main(): void {
  const logDir = isDev ? join(app.getPath('userData'), 'logs') : app.getPath('logs');
  const logger = createLogger({ process: 'main', logDir, stdout: isDev });
  const childEnv: ChildEnv = {
    TABREACH_DATA_DIR: app.getPath('userData'),
    TABREACH_LOG_DIR: logDir,
    TABREACH_APP_VERSION: app.getVersion(),
    TABREACH_DEV: isDev ? '1' : '0',
  };

  const rendererUrl = isDev && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
  const rendererOrigin = rendererUrl ? new URL(rendererUrl).origin : null;
  const rendererFile = join(__dirname, '../renderer/index.html');
  /** Only our own renderer page may use main-process IPC or receive a core port. */
  const isAppUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return rendererOrigin
        ? parsed.origin === rendererOrigin
        : parsed.protocol === 'file:' && decodeURI(parsed.pathname) === rendererFile;
    } catch {
      return false;
    }
  };

  let window: BrowserWindow | null = null;
  let windowLoaded = false;
  const selfCheck = parseSelfCheck(process.argv);
  let selfCheckStarted = false;
  let quitting = false;

  const core = new Supervised('core', join(__dirname, 'core.js'), childEnv, logger, isDev);
  const worker = new Supervised('worker', join(__dirname, 'worker.js'), childEnv, logger, isDev);

  /** Host channel to the current core process; replaced when core restarts. */
  let hostPeer: RpcPeer | null = null;

  core.onSpawn = (proc) => {
    hostPeer?.close();
    hostPeer = serveHost(proc, logger);
    connectRenderer();
    connectWorker();
    startSelfCheck();
  };
  core.onState = (state) => sendCoreState(state);
  worker.onSpawn = () => {
    connectWorker();
    startSelfCheck();
  };
  // A worker that crashed or was killed may leave Chrome running on a profile, holding its lock.
  const profilesRoot = join(app.getPath('userData'), 'profiles');
  worker.onExit = () => void killOrphanChrome(profilesRoot, logger);

  const stopChildren = () => Promise.all([core.stop(), worker.stop()]);

  /** Headless diagnostics mode: runs once both children are up, prints JSON, exits. */
  function startSelfCheck(): void {
    const coreProc = core.process;
    if (!selfCheck.enabled || selfCheckStarted || !coreProc || !worker.process) return;
    selfCheckStarted = true;
    void runSelfCheck(coreProc, selfCheck.url, logger).then(async (report) => {
      process.stdout.write(`TABREACH_SELF_CHECK ${JSON.stringify(report)}\n`);
      logger.info({ event: 'self_check.finished', ok: report.ok }, 'self-check finished');
      await stopChildren();
      app.exit(report.ok ? 0 : 1);
    });
  }

  /** Tells the renderer whether core can answer, so it can say so instead of waiting on timeouts. */
  function sendCoreState(state: CoreState): void {
    if (window && windowLoaded) window.webContents.send('tabreach:core-state', state);
  }

  /** renderer <-> core: a fresh channel for every page load and every core start. */
  function connectRenderer(): void {
    const coreProc = core.process;
    if (!coreProc || !window || !windowLoaded) return;
    if (!isAppUrl(window.webContents.getURL())) {
      logger.warn({ event: 'ipc.rejected_port_handoff' }, 'window is not showing the app page; no core port');
      return;
    }
    const { port1, port2 } = new MessageChannelMain();
    const handoff: PortHandoff = { __tabreach: 'port', name: 'app' };
    coreProc.postMessage(handoff, [port1]);
    window.webContents.postMessage('tabreach:port', null, [port2]);
    logger.info({ event: 'ipc.channel_created', name: 'app' }, 'renderer connected to core');
  }

  /** core <-> worker: re-created whenever either side (re)starts. */
  function connectWorker(): void {
    const coreProc = core.process;
    const workerProc = worker.process;
    if (!coreProc || !workerProc) return;
    const { port1, port2 } = new MessageChannelMain();
    const handoff: PortHandoff = { __tabreach: 'port', name: 'browser' };
    coreProc.postMessage(handoff, [port1]);
    workerProc.postMessage(handoff, [port2]);
    logger.info({ event: 'ipc.channel_created', name: 'browser' }, 'worker connected to core');
  }

  function createWindow(): void {
    window = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'TabReach',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: isDev,
      },
    });
    const wc = window.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, url) => {
      if (!rendererOrigin || !isAppUrl(url)) event.preventDefault();
    });
    // Only a real document load resets the connection. In-app hash routing also emits
    // did-start-loading, and treating that as a reload left the window without a core port
    // after the next core restart.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) windowLoaded = false;
    });
    wc.on('did-finish-load', () => {
      windowLoaded = true;
      sendCoreState(core.state);
      connectRenderer();
    });
    wc.on('render-process-gone', (_event, details) => {
      logger.error({ event: 'renderer.gone', reason: details.reason }, 'renderer process gone; reloading');
      if (details.reason !== 'clean-exit') wc.reload();
    });
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => {
      window = null;
      windowLoaded = false;
    });
    if (rendererUrl) {
      void window.loadURL(rendererUrl);
    } else {
      void window.loadFile(rendererFile);
    }
  }

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(
    () => {
      logger.info({ event: 'app.ready', version: app.getVersion(), packaged: app.isPackaged }, 'app ready');
      installMenu(isDev);
      // The app needs no browser permissions (camera, notifications, geolocation, …).
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
      registerSaveFile(isAppUrl, logger);
      // Sleep and wake: core stops claiming jobs, then re-plans overdue work (docs/17, "Sleep").
      const power = (type: 'power.suspend' | 'power.resume') => {
        logger.info({ event: type }, 'power state changed');
        hostPeer?.request(type, {}).catch((error: unknown) => {
          logger.warn(
            { event: 'power.notify_failed', type, err: error },
            'could not tell core about power state',
          );
        });
      };
      powerMonitor.on('suspend', () => power('power.suspend'));
      powerMonitor.on('resume', () => power('power.resume'));
      core.start();
      // Chrome left over from a previous run (the app crashed) would keep its profile locked.
      void killOrphanChrome(profilesRoot, logger).finally(() => worker.start());
      if (selfCheck.enabled) {
        setTimeout(() => {
          process.stderr.write('TABREACH_SELF_CHECK timed out\n');
          logger.error({ event: 'self_check.timeout' }, 'self-check timed out');
          void stopChildren().finally(() => app.exit(1));
        }, SELF_CHECK_DEADLINE_MS).unref();
      } else {
        createWindow();
      }
    },
    (error: unknown) => logger.error({ event: 'app.ready_failed', err: error }, 'app failed to start'),
  );

  app.on('window-all-closed', () => {
    if (!selfCheck.enabled) app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    // Let core close the database cleanly before the app exits (bounded by the supervisor).
    event.preventDefault();
    quitting = true;
    void stopChildren()
      .then(() => killOrphanChrome(profilesRoot, logger))
      .finally(() => app.quit());
  });
}

/** Answers core's host-channel requests: Electron-only capabilities (safeStorage). */
function serveHost(proc: UtilityProcess, logger: Logger): RpcPeer {
  const log = logger.child({ channel: 'host' });
  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new RpcError('UNAVAILABLE', 'Encryption is not available');
    }
  };
  return new RpcPeer(utilityProcessEndpoint(proc), {
    onInvalid: (reason) => log.warn({ event: 'ipc.invalid_message', reason }, 'dropped message'),
    onHandlerError: (type, err) => log.error({ event: 'ipc.handler_failed', type, err }, 'handler failed'),
  })
    .handle('secret.encrypt', ({ plaintext }) => {
      requireEncryption();
      return { ciphertext: safeStorage.encryptString(plaintext).toString('base64') };
    })
    .handle('oauth.loopback', async ({ authorizeUrl, timeoutMs, state }) => {
      log.info({ event: 'oauth.started' }, 'opening the consent page in the browser');
      const result = await runLoopback({
        authorizeUrl,
        timeoutMs,
        expectedState: state,
        open: (url) => shell.openExternal(url),
      });
      log.info(
        { event: 'oauth.redirect_received', ok: Boolean(result.params.code) },
        'OAuth redirect received',
      );
      return result;
    })
    .handle('secret.decrypt', ({ ciphertext }) => {
      requireEncryption();
      return { plaintext: safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) };
    });
}

// Entry point last: everything above must be initialized before main() runs.
if (!app.requestSingleInstanceLock()) {
  if (parseSelfCheck(process.argv).enabled) {
    process.stderr.write('TABREACH_SELF_CHECK another TabReach instance is running; quit it first\n');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  main();
}
