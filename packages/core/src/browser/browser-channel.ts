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

/** How a send reaches the worker: one task that ends in the checkpoint and one press. */
export interface BrowserDispatch {
  packId: string;
  packVersion: string;
  /** Assisted waits for the person: a longer timeout. */
  assisted: (message: OutgoingMessage, workflowRunId: string) => boolean;
  run: (
    worker: Pick<RpcPeer, 'request'>,
    task: { taskId: string; sessionId: string; message: OutgoingMessage; workflowRunId: string },
    options: { timeoutMs: number; correlationId: string },
  ) => Promise<TaskResult>;
}

/** A pack action as the dispatch (Phase 5c `commit` task). */
export function packActionDispatch(spec: BrowserActionSpec): BrowserDispatch {
  return {
    packId: spec.packId,
    packVersion: spec.packVersion,
    assisted: () => spec.mode === 'assisted',
    run: (worker, task, options) =>
      worker.request(
        'task.run',
        {
          taskId: task.taskId,
          sessionId: task.sessionId,
          taskType: 'commit',
          packId: spec.packId,
          url: spec.url(task.message),
          actionId: spec.actionId,
          params: spec.params(task.message),
          mode: spec.mode,
        },
        options,
      ),
  };
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
  readonly confirmedByPerson = true;
  readonly minSpacingMs: number;
  readonly dailyLimit: number | null;

  constructor(
    readonly channel: string,
    /** The browser profile that acts (the channel identity). */
    readonly accountId: string,
    private readonly dispatch: BrowserDispatch,
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
      .prepare(
        `SELECT s.workflow_run_id, r.correlation_id FROM side_effects s
         LEFT JOIN workflow_runs r ON r.id = s.workflow_run_id WHERE s.idempotency_key = ?`,
      )
      .get(message.idempotencyKey) as { workflow_run_id: string; correlation_id: string | null } | undefined;
    if (!effect) throw new Error('Unknown side effect');
    // The run's correlation id follows the action into the worker's logs (CLAUDE.md §5).
    const correlationId = effect.correlation_id ?? uuidv7();
    let sessionId: string;
    let live = this.d.browser.liveSessionOf(this.accountId);
    // A window handed over for a manual step whose outcome the person has since given: that work
    // is over, and the window comes back (otherwise the next step would wait on it for ever).
    if (live && live.controlMode === 'human' && this.handOverSettled(live.id)) {
      await this.d.browser.setControlMode(live.id, 'automation');
      live = this.d.browser.liveSessionOf(this.accountId);
    }
    // The person holds the profile's window: it is theirs (docs/11); the send waits for it.
    if (live && live.controlMode !== 'automation')
      return { outcome: 'not_sent', errorClass: 'profile.inUseByYou' };
    try {
      // A window already under automation is reused (the worker runs one task at a time in it).
      sessionId =
        live?.id ?? (await this.d.browser.openSession(this.accountId, 'automation', null, correlationId));
    } catch (error) {
      // Chrome did not start, or the profile is busy: nothing was done.
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
        this.dispatch.packId,
        this.dispatch.packVersion,
        this.d.now().toISOString(),
      );
    this.d.checkpoints.expect(taskId, hooks.beforeCommit);
    let result: TaskResult;
    try {
      result = await untilAborted(
        signal,
        () => this.cancel(worker, taskId, correlationId),
        this.dispatch.run(
          worker,
          { taskId, sessionId, message, workflowRunId: effect.workflow_run_id },
          {
            timeoutMs: this.dispatch.assisted(message, effect.workflow_run_id)
              ? ASSISTED_TIMEOUT_MS
              : TASK_TIMEOUT_MS,
            correlationId,
          },
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
      await this.quietly(this.d.browser.closeSession(sessionId), 'browser.close_failed', correlationId);
      throw error;
    }
    const reached = this.d.checkpoints.reached(taskId);
    this.d.checkpoints.forget(taskId);
    this.finishTask(taskId, result.status, result);
    const refs = { taskId, stateId: result.stateId, pack: `${this.dispatch.packId}@${result.packVersion}` };

    const close = () =>
      this.quietly(this.d.browser.closeSession(sessionId), 'browser.close_failed', correlationId);

    if (result.status === 'succeeded' && result.committed) {
      await close();
      return { outcome: 'completed', externalRefs: refs };
    }
    if (result.committed) {
      if (result.errorKey === 'task.rejected') {
        await close();
        return { outcome: 'not_sent', errorClass: 'site_rejected', permanent: true };
      }
      // Manual (ADR 015): the window is the person's to finish in; they say whether it was sent.
      if (result.errorKey === 'task.manual') {
        await this.quietly(
          this.d.browser.setControlMode(sessionId, 'human'),
          'browser.hand_over_failed',
          correlationId,
        );
        return { outcome: 'unknown', errorClass: 'manual' };
      }
      // Left open and paused so the person can see what the page shows before deciding; a window
      // the person already holds stays theirs (docs/11).
      if (this.d.browser.sessionById(sessionId)?.controlMode === 'automation') {
        await this.quietly(
          this.d.browser.setControlMode(sessionId, 'paused'),
          'browser.pause_failed',
          correlationId,
        );
      }
      return { outcome: 'unknown', errorClass: 'browser_unverified' };
    }
    // Not pressed — the worker says so, even after the checkpoint — so nothing was sent.
    if (reached) {
      this.d.logger.info(
        { event: 'browser.not_pressed_after_checkpoint', taskId, errorKey: result.errorKey, correlationId },
        'checkpoint recorded, control not pressed',
      );
    }
    if (result.status === 'needs_human' || result.errorKey === 'task.controlTaken') {
      // A challenge, or the person took the window: it stays open for them, never closed here.
      return {
        outcome: 'not_sent',
        errorClass: result.status === 'needs_human' ? 'needs_human' : 'user_control',
      };
    }
    await close();
    return {
      outcome: 'not_sent',
      // A known page that is not the action's (an invitation already pending, not connected yet):
      // the engine decides what that means for the step.
      errorClass:
        result.status === 'unsupported_state' && result.stateId && !result.errorKey
          ? `state:${result.stateId}`
          : (result.errorKey ?? result.status),
      // A page outside the pack's allowlist does not change by retrying (docs/07).
      permanent: result.status === 'unsupported_state' && !result.stateId,
    };
  }

  private async cancel(
    worker: Pick<RpcPeer, 'request'>,
    taskId: string,
    correlationId: string,
  ): Promise<void> {
    await this.quietly(
      worker.request('task.cancel', { taskId }, { correlationId }),
      'browser.cancel_failed',
      correlationId,
    );
  }

  /** Housekeeping whose failure changes no outcome; logged, never thrown. */
  private async quietly(work: Promise<unknown>, event: string, correlationId: string): Promise<void> {
    await work.catch((error: unknown) => this.d.logger.warn({ event, correlationId, err: error }, event));
  }

  /**
   * The window's last task handed it to the person for a manual step (`task.manual`), and they have
   * said what happened (its ledger entry is no longer unknown or executing).
   */
  private handOverSettled(sessionId: string): boolean {
    const last = this.d.db
      .prepare(
        `SELECT result, workflow_run_id FROM browser_tasks WHERE browser_session_id = ?
         ORDER BY dispatched_at DESC LIMIT 1`,
      )
      .get(sessionId) as { result: string | null; workflow_run_id: string | null } | undefined;
    if (!last?.result || !last.workflow_run_id) return false;
    const result = JSON.parse(last.result) as { errorKey?: string | null };
    if (result.errorKey !== 'task.manual') return false;
    const open = this.d.db
      .prepare(
        `SELECT 1 FROM side_effects WHERE workflow_run_id = ? AND status IN ('unknown', 'executing') LIMIT 1`,
      )
      .get(last.workflow_run_id);
    return open === undefined;
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

/** Stops waiting when the job is cancelled, and tells the worker to stop the task too. */
export function untilAborted<T>(signal: AbortSignal, onAbort: () => void, work: Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
