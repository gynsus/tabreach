import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  RpcPeer,
  uuidv7,
  type ChangedEntity,
  type ComponentStatus,
  type HealthReport,
  type LaunchCheckResult,
  type Logger,
  type MessageEndpoint,
} from '@tabreach/protocol';
import { AppServices } from './app-handlers.js';
import { openDatabase, sqliteVersion } from './db/database.js';
import { currentSchemaVersion, migrate, type MigrationReport } from './db/migrate.js';
import { migrations } from './db/migrations.js';
import { Dispatcher } from './jobs/dispatcher.js';
import { SecretStore, type SecretCipher } from './secrets/secrets.js';

export interface CoreOptions {
  /** Application data directory (`~/Library/Application Support/TabReach`). */
  dataDir: string;
  appVersion: string;
  electronVersion: string | null;
  /** Channel to the main process for Electron-only capabilities (safeStorage). */
  host: MessageEndpoint;
  logger: Logger;
}

const WORKER_HEALTH_TIMEOUT_MS = 5_000;
const LAUNCH_CHECK_TIMEOUT_MS = 90_000;

export class CoreService {
  private readonly hostPeer: RpcPeer;
  private readonly appPeers = new Set<RpcPeer>();
  private workerPeer: RpcPeer | null = null;
  private secretsStatus: { status: ComponentStatus; detail?: string } = { status: 'unknown' };
  readonly services: AppServices;
  readonly dispatcher: Dispatcher;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly options: CoreOptions,
    readonly migration: MigrationReport,
  ) {
    this.hostPeer = new RpcPeer(options.host, this.peerOptions('host'));
    this.services = new AppServices(db, {
      logger: options.logger,
      worker: () => this.workerPeer,
      keepAwake: (on) => {
        this.hostPeer
          .request('power.keepAwake', { on })
          .catch((error: unknown) =>
            options.logger.warn({ event: 'power.keep_awake_failed', err: error }, 'main did not answer'),
          );
      },
      notify: (title, body) => {
        this.hostPeer
          .request('app.notify', { title, body })
          .catch((error: unknown) =>
            options.logger.warn({ event: 'app.notify_failed', err: error }, 'main did not answer'),
          );
      },
      onChanged: (entities) => this.announce(entities),
      // Deferred: the enqueuing transaction must commit before the dispatcher looks.
      onJobEnqueued: () => queueMicrotask(() => this.dispatcher.wake()),
      cipher: this.cipher(),
      gmail: {
        http: (url, init) => fetch(url, init),
        loopback: (authorizeUrl, timeoutMs, state) =>
          this.hostPeer.request(
            'oauth.loopback',
            { authorizeUrl, timeoutMs, state },
            { timeoutMs: timeoutMs + 30_000 },
          ),
      },
    });
    this.dispatcher = new Dispatcher({
      queue: this.services.jobs,
      now: () => new Date(),
      logger: options.logger.child({ component: 'jobs' }),
      onFinished: (_job, status) => {
        if (status === 'failed' || status === 'dead') this.announce(['job', 'enrollment']);
      },
    });
    this.hostPeer
      .handle('power.suspend', () => {
        this.dispatcher.pause();
        options.logger.info({ event: 'power.suspend' }, 'system going to sleep; jobs paused');
        return { ok: true as const };
      })
      .handle('control.fromTray', async ({ action }) => {
        const ctx = { correlationId: uuidv7() };
        if (action === 'pause') this.services.appControl.pauseAll(ctx);
        else if (action === 'resume') this.services.appControl.resumeAll(ctx);
        else await this.services.appControl.emergencyStop(ctx);
        return { ok: true as const };
      })
      .handle('power.resume', () => {
        this.dispatcher.resume();
        this.services.engine.resync();
        this.services.inbox.resync();
        this.services.research.resync();
        options.logger.info({ event: 'power.resume' }, 'system woke up; jobs resumed');
        return { ok: true as const };
      });
  }

  static async start(options: CoreOptions): Promise<CoreService> {
    const dataDir = join(options.dataDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const db = openDatabase(join(dataDir, 'app.db'));
    const report = await migrate(db, migrations, { backupDir: join(dataDir, 'backups') });
    options.logger.info({ event: 'db.migrated', ...report }, 'database ready');

    const core = new CoreService(db, options, report);
    const pruned = core.services.commands.prune();
    if (pruned > 0)
      options.logger.info({ event: 'commands.pruned', count: pruned }, 'old command results pruned');
    await core.checkSecretStorage();
    for (const type of [
      ...core.services.engine.jobTypes(),
      ...core.services.inbox.jobTypes(),
      ...core.services.classifier.jobTypes(),
      ...core.services.research.jobTypes(),
      ...core.services.signInChecks.jobTypes(),
    ]) {
      core.dispatcher.register(type);
    }
    core.dispatcher.start();
    core.services.engine.resync();
    core.services.inbox.resync();
    core.services.research.resync();
    core.services.appControl.syncKeepAwake();
    return core;
  }

  /** Attaches a renderer connection (a new one after every window reload). */
  attachApp(endpoint: MessageEndpoint): () => void {
    const peer = new RpcPeer(endpoint, this.peerOptions('app'));
    this.services
      .register(peer)
      .handle('app.health', () => this.health())
      .handle('browser.launchCheck', (payload, ctx) => this.launchCheck(payload.url, ctx.correlationId));
    this.appPeers.add(peer);
    return () => {
      peer.close();
      this.appPeers.delete(peer);
    };
  }

  /**
   * Attaches the browser worker, replacing a previous (crashed or restarted) one. The returned
   * detach only affects this connection: a late close event from an old worker's port must not
   * disconnect the new worker.
   */
  attachWorker(endpoint: MessageEndpoint): () => void {
    this.workerPeer?.close();
    const peer = new RpcPeer(endpoint, this.peerOptions('browser'));
    this.workerPeer = peer;
    peer.on('session.changed', (change) => this.services.browser.onSessionChanged(change));
    peer.on('worker.heartbeat', ({ sessions }) => this.services.browser.onHeartbeat(sessions));
    peer.on('session.modeChanged', (change) => this.services.signInChecks.onModeChanged(change));
    return () => {
      peer.close();
      if (this.workerPeer === peer) {
        this.workerPeer = null;
        // Its Chrome windows went with it (main cleans up any that survived).
        this.services.browser.onWorkerDetached();
      }
    };
  }

  async health(): Promise<HealthReport> {
    return {
      checkedAt: new Date().toISOString(),
      app: {
        version: this.options.appVersion,
        electron: this.options.electronVersion,
        node: process.versions.node,
      },
      core: { status: 'ok' },
      database: this.databaseHealth(),
      secrets: this.secretsStatus,
      worker: await this.workerHealth(),
    };
  }

  close(): void {
    this.dispatcher.stop();
    for (const peer of this.appPeers) peer.close();
    this.appPeers.clear();
    this.workerPeer?.close();
    this.workerPeer = null;
    this.hostPeer.close();
    this.db.close();
  }

  private announce(entities: ChangedEntity[]): void {
    for (const peer of this.appPeers) peer.emit('data.changed', { entities });
    // A campaign started or stopped: the Mac may now sleep, or must stay awake (FR-APP-004).
    if (entities.includes('campaign')) this.services?.appControl.syncKeepAwake();
  }

  private async launchCheck(url: string, correlationId: string): Promise<LaunchCheckResult> {
    if (!this.workerPeer)
      throw new RpcError('UNAVAILABLE', 'Browser worker is not running', 'worker.notRunning');
    const result = await this.workerPeer.request(
      'worker.launchCheck',
      { url },
      { correlationId, timeoutMs: LAUNCH_CHECK_TIMEOUT_MS },
    );
    this.options.logger.info(
      { event: 'browser.launch_check', correlationId, ...result },
      'launch check finished',
    );
    return result;
  }

  private databaseHealth(): HealthReport['database'] {
    try {
      return {
        status: 'ok',
        sqliteVersion: sqliteVersion(this.db),
        schemaVersion: currentSchemaVersion(this.db),
      };
    } catch (error) {
      this.options.logger.error({ event: 'db.health_failed', err: error }, 'database health check failed');
      return { status: 'down', sqliteVersion: null, schemaVersion: 0, detail: 'database.queryFailed' };
    }
  }

  private async workerHealth(): Promise<HealthReport['worker']> {
    if (!this.workerPeer) return { status: 'down', detail: 'worker.notRunning' };
    try {
      return await this.workerPeer.request('worker.health', {}, { timeoutMs: WORKER_HEALTH_TIMEOUT_MS });
    } catch (error) {
      this.options.logger.warn({ event: 'worker.health_failed', err: error }, 'worker health check failed');
      return { status: 'down', detail: 'worker.unreachable' };
    }
  }

  /** Round-trips a throwaway secret through main's safeStorage and the secrets table. */
  private async checkSecretStorage(): Promise<void> {
    const store = new SecretStore(this.db, this.cipher());
    const probe = `self-test-${Date.now()}`;
    let id: string | null = null;
    try {
      id = await store.put('self_test', probe);
      const back = await store.reveal(id);
      this.secretsStatus = back === probe ? { status: 'ok' } : { status: 'down', detail: 'secrets.mismatch' };
    } catch (error) {
      const detail =
        error instanceof RpcError && error.problem.code === 'UNAVAILABLE'
          ? 'secrets.encryptionUnavailable'
          : 'secrets.unavailable';
      this.options.logger.error(
        { event: 'secrets.self_test_failed', err: error },
        'secret storage self-test failed',
      );
      this.secretsStatus = { status: 'down', detail };
    } finally {
      if (id) store.delete(id);
    }
  }

  private cipher(): SecretCipher {
    return {
      encrypt: async (plaintext) => (await this.hostPeer.request('secret.encrypt', { plaintext })).ciphertext,
      decrypt: async (ciphertext) =>
        (await this.hostPeer.request('secret.decrypt', { ciphertext })).plaintext,
    };
  }

  private peerOptions(channel: string) {
    const log = this.options.logger.child({ channel });
    return {
      onInvalid: (reason: string) => log.warn({ event: 'ipc.invalid_message', reason }, 'dropped message'),
      onHandlerError: (type: string, err: unknown) =>
        log.error({ event: 'ipc.handler_failed', type, err }, 'handler failed'),
    };
  }
}
