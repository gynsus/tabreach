import type { DatabaseSync } from 'node:sqlite';
import {
  appControlSchema,
  type AppControl,
  type ChangedEntity,
  type Logger,
  type RpcPeer,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SettingsRepository } from '../settings/settings.js';

const KEY = 'app.control';
const DEFAULTS: AppControl = { paused: false, pausedAt: null, emergencyStoppedAt: null, keepAwake: false };

/**
 * App-wide control (docs/19 "Global pause and emergency stop", FR-BRA-008, FR-APP-004).
 * Pause: no new external action starts — sends are deferred at the final pre-send check and
 * browser tasks do not start; reading the inbox goes on so replies still stop sequences.
 * Emergency stop: pause, and the worker stops every browser task and pauses every session at once.
 */
export class AppControlService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      settings: SettingsRepository;
      audit: AuditLog;
      now: () => Date;
      worker: () => Pick<RpcPeer, 'request'> | null;
      /** Tells main whether to keep the Mac awake. */
      keepAwake: (on: boolean) => void;
      changed: (entities: ChangedEntity[]) => void;
      logger: Logger;
    },
  ) {}

  get(): AppControl {
    return this.d.settings.get(KEY, appControlSchema) ?? DEFAULTS;
  }

  isPaused(): boolean {
    return this.get().paused;
  }

  pauseAll(ctx: CommandContext): AppControl {
    if (!this.get().paused) {
      this.save({ ...this.get(), paused: true, pausedAt: this.d.now().toISOString() });
      this.record('app.paused', ctx);
    }
    return this.get();
  }

  resumeAll(ctx: CommandContext): AppControl {
    if (this.get().paused) {
      this.save({ ...this.get(), paused: false, pausedAt: null, emergencyStoppedAt: null });
      this.record('app.resumed', ctx);
    }
    return this.get();
  }

  async emergencyStop(ctx: CommandContext): Promise<AppControl> {
    const now = this.d.now().toISOString();
    this.save({ ...this.get(), paused: true, pausedAt: this.get().pausedAt ?? now, emergencyStoppedAt: now });
    this.record('app.emergency_stop', ctx);
    const worker = this.d.worker();
    if (worker) {
      await worker.request('worker.emergencyStop', {}).catch((error: unknown) => {
        // Paused either way; a worker that does not answer is being restarted and runs nothing.
        this.d.logger.warn(
          { event: 'app.emergency_stop_worker_failed', err: error },
          'worker did not confirm',
        );
      });
    }
    return this.get();
  }

  setKeepAwake(keepAwake: boolean, ctx: CommandContext): AppControl {
    this.save({ ...this.get(), keepAwake });
    this.record('app.keep_awake_changed', ctx);
    return this.get();
  }

  /** Keeps the Mac awake only while it is wanted and a campaign is active. */
  syncKeepAwake(): void {
    const active = this.d.db.prepare(`SELECT 1 FROM campaigns WHERE status = 'active' LIMIT 1`).get();
    this.d.keepAwake(this.get().keepAwake && active !== undefined && !this.get().paused);
  }

  private save(control: AppControl): void {
    this.d.settings.set(KEY, control);
    this.syncKeepAwake();
    this.d.changed(['settings', 'activity']);
  }

  private record(
    actionType: 'app.paused' | 'app.resumed' | 'app.emergency_stop' | 'app.keep_awake_changed',
    ctx: CommandContext,
  ): void {
    this.d.audit.record({
      actorType: 'user',
      actionType,
      objectType: 'settings',
      correlationId: ctx.correlationId,
    });
  }
}
