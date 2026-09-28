import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  safeStorage,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { RpcError, RpcPeer, type Logger } from '@tabreach/protocol';
import { createLogger } from '../shared/logger';
import { utilityProcessEndpoint, type ChildEnv, type PortHandoff } from '../shared/ipc';
import { RestartPolicy } from './restart-policy';
import { parseSelfCheck, runSelfCheck } from './self-check';

const isDev = !app.isPackaged;
if (isDev) {
  // Keep development data away from a real installation; tests point this at a temp dir.
  app.setPath('userData', process.env.TABREACH_USER_DATA_DIR ?? join(app.getPath('appData'), 'TabReach-dev'));
}

function main(): void {
  const logDir = isDev ? join(app.getPath('userData'), 'logs') : app.getPath('logs');
  const logger = createLogger({ process: 'main', logDir, stdout: isDev });
  const childEnv: ChildEnv = {
    TABREACH_DATA_DIR: app.getPath('userData'),
    TABREACH_LOG_DIR: logDir,
    TABREACH_APP_VERSION: app.getVersion(),
    TABREACH_DEV: isDev ? '1' : '0',
  };

  let window: BrowserWindow | null = null;
  let windowLoaded = false;
  const selfCheck = parseSelfCheck(process.argv);
  let selfCheckStarted = false;

  const core = new Supervised('core', join(__dirname, 'core.js'), childEnv, logger);
  const worker = new Supervised('worker', join(__dirname, 'worker.js'), childEnv, logger);

  core.onSpawn = (proc) => {
    serveHost(proc, logger);
    connectRenderer();
    connectWorker();
    startSelfCheck();
  };
  worker.onSpawn = () => {
    connectWorker();
    startSelfCheck();
  };

  /** Headless diagnostics mode: runs once both children are up, prints JSON, exits. */
  function startSelfCheck(): void {
    const coreProc = core.process;
    if (!selfCheck.enabled || selfCheckStarted || !coreProc || !worker.process) return;
    selfCheckStarted = true;
    void runSelfCheck(coreProc, selfCheck.url, logger).then((report) => {
      process.stdout.write(`TABREACH_SELF_CHECK ${JSON.stringify(report)}\n`);
      logger.info({ event: 'self_check.finished', ok: report.ok }, 'self-check finished');
      core.stop();
      worker.stop();
      app.exit(report.ok ? 0 : 1);
    });
  }

  /** renderer <-> core: a fresh channel for every page load and every core start. */
  function connectRenderer(): void {
    const coreProc = core.process;
    if (!coreProc || !window || !windowLoaded) return;
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
      width: 980,
      height: 760,
      show: false,
      title: 'TabReach',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    const allowedUrl = isDev && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : null;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!allowedUrl || !url.startsWith(allowedUrl)) event.preventDefault();
    });
    window.webContents.on('did-start-loading', () => {
      windowLoaded = false;
    });
    window.webContents.on('did-finish-load', () => {
      windowLoaded = true;
      connectRenderer();
    });
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => {
      window = null;
      windowLoaded = false;
    });
    if (allowedUrl) {
      void window.loadURL(allowedUrl);
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'));
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
      core.start();
      worker.start();
      if (!selfCheck.enabled) createWindow();
    },
    (error: unknown) => logger.error({ event: 'app.ready_failed', err: error }, 'app failed to start'),
  );

  app.on('window-all-closed', () => {
    if (!selfCheck.enabled) app.quit();
  });
  app.on('before-quit', () => {
    core.stop();
    worker.stop();
  });
}

/** Answers core's host-channel requests: Electron-only capabilities (safeStorage). */
function serveHost(proc: UtilityProcess, logger: Logger): void {
  const log = logger.child({ channel: 'host' });
  const requireEncryption = () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new RpcError('UNAVAILABLE', 'Encryption is not available');
    }
  };
  new RpcPeer(utilityProcessEndpoint(proc), {
    onInvalid: (reason) => log.warn({ event: 'ipc.invalid_message', reason }, 'dropped message'),
    onHandlerError: (type, err) => log.error({ event: 'ipc.handler_failed', type, err }, 'handler failed'),
  })
    .handle('secret.encrypt', ({ plaintext }) => {
      requireEncryption();
      return { ciphertext: safeStorage.encryptString(plaintext).toString('base64') };
    })
    .handle('secret.decrypt', ({ ciphertext }) => {
      requireEncryption();
      return { plaintext: safeStorage.decryptString(Buffer.from(ciphertext, 'base64')) };
    });
}

/** A utility process restarted by main with bounded backoff (ADR 012). */
class Supervised {
  process: UtilityProcess | null = null;
  onSpawn: (proc: UtilityProcess) => void = () => {};
  private readonly policy = new RestartPolicy();
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly name: 'core' | 'worker',
    private readonly entry: string,
    private readonly env: ChildEnv,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.restartTimer = null;
    const proc = utilityProcess.fork(this.entry, [], {
      serviceName: `TabReach ${this.name}`,
      env: { ...process.env, ...this.env },
      stdio: isDev ? 'inherit' : 'ignore',
    });
    proc.once('spawn', () => {
      this.process = proc;
      this.logger.info({ event: 'process.spawned', name: this.name, pid: proc.pid }, 'process spawned');
      this.onSpawn(proc);
    });
    proc.once('exit', (code) => {
      if (this.process === proc) this.process = null;
      if (this.stopping) return;
      const decision = this.policy.onCrash();
      this.logger.error({ event: 'process.exited', name: this.name, code, ...decision }, 'process exited');
      if (decision.restart) {
        this.restartTimer = setTimeout(() => this.start(), decision.delayMs);
      }
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.process?.kill();
  }
}

// Entry point last: classes above must be initialized before main() runs.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}
