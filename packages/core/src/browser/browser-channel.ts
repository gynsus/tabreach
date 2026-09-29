import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type BrowserExecutionMode,
  type Logger,
  type RpcPeer,
  type TaskResult,
} from '@tabreach/protocol';
import type {
  MessageChannel,
  OutgoingMessage,
  ReconcileResult,
  SendHooks,
  SendResult,
} from '../channels/channel.js';
import type { BrowserService } from './browser-service.js';
import type { BrowserCheckpoints } from './checkpoints.js';

const TASK_TIMEOUT_MS = 180_000;
const ASSISTED_TIMEOUT_MS = TASK_TIMEOUT_MS + 10 * 60_000;

/** Which pack action does the send, and what goes into its fields. */
export interface BrowserActionSpec {
  packId: string;
  packVersion: string;
  actionId: string;
  /** The page the action starts on; the target (a form URL) by default. */
  url: (message: OutgoingMessage) => string;
  params: (message: OutgoingMessage) => Record<string, string>;
  mode: BrowserExecutionMode;
}

/**
 * A channel whose send is one critical browser action (docs/07, Phase 5c): the pack action runs in
 * a profile under automation, and the ledger turns `executing` only at the worker's
 * `about_to_commit` checkpoint. Web forms (Phase 6) and LinkedIn (Phase 7) are built on it.
 *
 * Outcomes: a recognized success is `completed`; a failure before the checkpoint, or a refusal the
 * site showed, is a verified `not_sent`; anything else after the checkpoint is `unknown` — the
 * window stays open and paused so the person can look, and a person decides (ADR 018
 * `user_confirmation`). It is never pressed again automatically.
 */
export class BrowserActionChannel implements MessageChannel {
  readonly commitsAtCheckpoint = true;
  readonly minSpacingMs: number;
  readonly dailyLimit: number | null;

  constructor(
    readonly channel: string,
    /** The browser profile that acts (the channel identity). */
    readonly accountId: string,
    private readonly spec: BrowserActionSpec,
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      browser: BrowserService;
      checkpoints: BrowserCheckpoints;
      worker: () => Pick<RpcPeer, 'request'> | null;
      logger: Logger;
    },
    limits: { minSpacingMs?: number; dailyLimit?: number | null } = {},
  ) {
    this.minSpacingMs = limits.minSpacingMs ?? 0;
    this.dailyLimit = limits.dailyLimit ?? null;
  }

  async send(message: OutgoingMessage, signal: AbortSignal, hooks?: SendHooks): Promise<SendResult> {
    if (!hooks) throw new Error('A browser action needs the checkpoint hook');
    const worker = this.d.worker();
    if (!worker) return { outcome: 'not_sent', errorClass: 'worker_not_running' };
    const effect = this.d.db
      .prepare('SELECT workflow_run_id FROM side_effects WHERE idempotency_key = ?')
      .get(message.idempotencyKey) as { workflow_run_id: string } | undefined;
    if (!effect) throw new Error('Unknown side effect');
    const correlationId = uuidv7();
    let sessionId: string;
    try {
      sessionId = await this.d.browser.openSession(this.accountId, 'automation', null, correlationId);
    } catch (error) {
      // The person holds the window, or Chrome did not start: nothing was done.
      if (error instanceof RpcError)
        return { outcome: 'not_sent', errorClass: error.problem.detail ?? 'profile' };
      throw error;
    }

    const taskId = uuidv7();
    this.d.db
      .prepare(
        `INSERT INTO browser_tasks (id, workflow_run_id, task_type, browser_profile_id, browser_session_id,
                                    adapter_pack_id, adapter_pack_version, status, dispatched_at)
         VALUES (?, ?, 'commit', ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        taskId,
        effect.workflow_run_id,
        this.accountId,
        sessionId,
        this.spec.packId,
        this.spec.packVersion,
        this.d.now().toISOString(),
      );
    this.d.checkpoints.expect(taskId, hooks.beforeCommit);
    let result: TaskResult;
    try {
      result = await untilAborted(
        signal,
        worker.request(
          'task.run',
          {
            taskId,
            sessionId,
            taskType: 'commit',
            packId: this.spec.packId,
            url: this.spec.url(message),
            actionId: this.spec.actionId,
            params: this.spec.params(message),
            mode: this.spec.mode,
          },
          { timeoutMs: this.spec.mode === 'assisted' ? ASSISTED_TIMEOUT_MS : TASK_TIMEOUT_MS, correlationId },
        ),
      );
    } catch (error) {
      const reached = this.d.checkpoints.reached(taskId);
      this.finishTask(taskId, 'interrupted', null);
      this.d.checkpoints.forget(taskId);
      this.d.logger.warn(
        { event: 'browser.action_interrupted', taskId, afterCheckpoint: reached, err: error },
        'browser action interrupted',
      );
      // The worker died or stopped answering: after the checkpoint the press may have happened.
      if (reached) return { outcome: 'unknown', errorClass: 'worker_lost_after_checkpoint' };
      await this.d.browser.closeSession(sessionId).catch(() => {});
      throw error;
    }
    const reached = this.d.checkpoints.reached(taskId);
    this.d.checkpoints.forget(taskId);
    this.finishTask(taskId, result.status, result);
    const refs = { taskId, stateId: result.stateId, pack: `${this.spec.packId}@${result.packVersion}` };

    if (result.status === 'succeeded' && result.committed) {
      await this.d.browser.closeSession(sessionId).catch(() => {});
      return { outcome: 'completed', externalRefs: refs };
    }
    if (result.committed || reached) {
      if (result.errorKey === 'task.rejected') {
        await this.d.browser.closeSession(sessionId).catch(() => {});
        return { outcome: 'not_sent', errorClass: 'site_rejected', permanent: true };
      }
      // Left open and paused: the person can see what the page shows before deciding.
      await this.d.browser.setControlMode(sessionId, 'paused').catch(() => {});
      return { outcome: 'unknown', errorClass: 'browser_unverified' };
    }
    await this.d.browser.closeSession(sessionId).catch(() => {});
    return {
      outcome: 'not_sent',
      errorClass: result.status === 'failed' ? (result.errorKey ?? 'task.failed') : result.status,
      // A page outside the pack's allowlist does not change by retrying (docs/07).
      permanent: result.status === 'unsupported_state',
    };
  }

  /** A generic browser action leaves nothing to look up afterwards: a person confirms. */
  reconcile(): Promise<ReconcileResult> {
    return Promise.resolve({ status: 'unknown' });
  }

  private finishTask(taskId: string, status: string, result: TaskResult | null): void {
    this.d.db
      .prepare('UPDATE browser_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, result ? JSON.stringify(result) : null, this.d.now().toISOString(), taskId);
  }
}

/** Stops waiting when the job is cancelled; the worker's own task is bounded by its timeout. */
function untilAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
