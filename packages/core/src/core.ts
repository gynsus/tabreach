import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  RpcPeer,
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

  private constructor(
    private readonly db: DatabaseSync,
    private readonly options: CoreOptions,
    readonly migration: MigrationReport,
  ) {
    this.hostPeer = new RpcPeer(options.host, this.peerOptions('host'));
    this.services = new AppServices(db);
  }

  static async start(options: CoreOptions): Promise<CoreService> {
    const dataDir = join(options.dataDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    const db = openDatabase(join(dataDir, 'app.db'));
    const report = await migrate(db, migrations, { backupDir: join(dataDir, 'backups') });
    options.logger.info({ event: 'db.migrated', ...report }, 'database ready');

    const core = new CoreService(db, options, report);
    await core.checkSecretStorage();
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

  /** Attaches the browser worker, replacing a previous (crashed or restarted) one. */
  attachWorker(endpoint: MessageEndpoint): void {
    this.workerPeer?.close();
    this.workerPeer = new RpcPeer(endpoint, this.peerOptions('browser'));
  }

  detachWorker(): void {
    this.workerPeer?.close();
    this.workerPeer = null;
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
    for (const peer of this.appPeers) peer.close();
    this.appPeers.clear();
    this.detachWorker();
    this.hostPeer.close();
    this.db.close();
  }

  private async launchCheck(url: string, correlationId: string): Promise<LaunchCheckResult> {
    if (!this.workerPeer) throw new RpcError('UNAVAILABLE', 'Browser worker is not running');
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
      return { status: 'down', sqliteVersion: null, schemaVersion: 0, detail: 'Database query failed' };
    }
  }

  private async workerHealth(): Promise<HealthReport['worker']> {
    if (!this.workerPeer) return { status: 'down', detail: 'Browser worker is not running' };
    try {
      return await this.workerPeer.request('worker.health', {}, { timeoutMs: WORKER_HEALTH_TIMEOUT_MS });
    } catch (error) {
      const detail = error instanceof RpcError ? error.problem.title : 'Unexpected error';
      return { status: 'down', detail };
    }
  }

  /** Round-trips a throwaway secret through main's safeStorage and the secrets table. */
  private async checkSecretStorage(): Promise<void> {
    const store = new SecretStore(this.db, this.cipher());
    const probe = `self-test-${Date.now()}`;
    try {
      const id = await store.put('self_test', probe);
      const back = await store.reveal(id);
      store.delete(id);
      this.secretsStatus =
        back === probe ? { status: 'ok' } : { status: 'down', detail: 'Round trip mismatch' };
    } catch (error) {
      const detail = error instanceof RpcError ? error.problem.title : 'Secret storage unavailable';
      this.options.logger.error(
        { event: 'secrets.self_test_failed', err: error },
        'secret storage self-test failed',
      );
      this.secretsStatus = { status: 'down', detail };
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
