import type { DatabaseSync } from 'node:sqlite';
import { SIGN_IN_CHECK_URL, bundledPack } from '@tabreach/adapter-packs';
import {
  RpcError,
  uuidv7,
  type BrowserProfile,
  type ChangedEntity,
  type Intervention,
  type InterventionReason,
  type Logger,
  type RpcPeer,
  type TaskDiagnostics,
  type TaskResult,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import { RetryableError, type JobType } from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { BrowserService } from './browser-service.js';

export const JOB_BROWSER_CHECK = 'browser.check';
const WORKFLOW_TYPE = 'browser_check';
const TASK_TIMEOUT_MS = 150_000;

interface RunRow {
  id: string;
  business_id: string;
  status: string;
  current_state: string;
  context: string;
  correlation_id: string;
}

type Worker = Pick<RpcPeer, 'request'>;

/**
 * "Is this profile signed in?" as a workflow (docs/13, Phase 5b): the profile opens under
 * automation, the page is recognized against the channel pack. A challenge or an unknown page
 * becomes a request to the person and the run waits (`waiting_for_human`); the person's "done"
 * checks again in the same window, "cancel" ends it. Closing the window ends it too.
 */
export class SignInCheckService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      audit: AuditLog;
      jobs: JobQueue;
      browser: BrowserService;
      worker: () => Worker | null;
      changed: (entities: ChangedEntity[]) => void;
      logger: Logger;
    },
  ) {
    d.browser.onSessionEnded = (sessionId) => this.sessionEnded(sessionId);
  }

  jobTypes(): JobType<never>[] {
    const type: JobType<{ runId: string }> = {
      type: JOB_BROWSER_CHECK,
      payload: z.object({ runId: z.uuid() }),
      sideEffecting: false,
      // One browser task at a time (docs/13 "per profile"; profiles are few in 5b).
      concurrency: 1,
      maxAttempts: 3,
      maxAgeMs: 60 * 60_000,
      handler: ({ runId }) => this.step(runId),
    };
    return [type] as unknown as JobType<never>[];
  }

  start(profileId: string, packId: 'linkedin', ctx: CommandContext): BrowserProfile {
    const profile = this.d.browser.get(profileId);
    if (profile.status === 'archived') throw conflict('profile.archived');
    const live = this.d.browser.liveSessionOf(profileId);
    // A window the person holds is theirs: automation never takes it over (docs/11).
    if (live) throw conflict(live.controlMode === 'human' ? 'profile.inUseByYou' : 'profile.checking');
    transaction(this.d.db, () => {
      const id = uuidv7();
      const ts = this.d.now().toISOString();
      this.d.db
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_type, definition_version, business_type, business_id, status,
                                      current_state, context, correlation_id, created_at, updated_at)
           VALUES (?, ?, 1, 'browser_profile', ?, 'pending', 'RUN_TASK', ?, ?, ?, ?)`,
        )
        .run(
          id,
          WORKFLOW_TYPE,
          profileId,
          JSON.stringify({ packId, sessionId: null }),
          ctx.correlationId,
          ts,
          ts,
        );
      this.d.jobs.enqueue(
        JOB_BROWSER_CHECK,
        { runId: id },
        { dedupeKey: `browser-check:${id}`, correlationId: ctx.correlationId },
      );
    });
    this.d.changed(['browser']);
    return this.d.browser.get(profileId);
  }

  // The workflow -------------------------------------------------------------------------------

  private async step(runId: string): Promise<void> {
    const run = this.run(runId);
    if (!run || (run.status !== 'pending' && run.status !== 'running')) return;
    const context = JSON.parse(run.context) as { packId: string; sessionId: string | null };
    const worker = this.d.worker();
    if (!worker) throw new RetryableError('worker_not_running');
    const url = SIGN_IN_CHECK_URL[context.packId];
    const pack = bundledPack(context.packId);
    if (!url || !pack) return this.finish(run, 'failed');

    let sessionId = context.sessionId;
    if (!sessionId || this.d.browser.sessionById(sessionId)?.status !== 'open') {
      sessionId = await this.d.browser.openSession(run.business_id, 'automation', null, run.correlation_id);
      this.update(run.id, { status: 'running', context: { ...context, sessionId } });
    }
    const taskId = uuidv7();
    this.d.db
      .prepare(
        `INSERT INTO browser_tasks (id, workflow_run_id, task_type, browser_profile_id, browser_session_id,
                                    adapter_pack_id, adapter_pack_version, status, dispatched_at)
         VALUES (?, ?, 'check_state', ?, ?, ?, ?, 'running', ?)`,
      )
      .run(taskId, run.id, run.business_id, sessionId, pack.id, pack.version, this.d.now().toISOString());
    let result: TaskResult;
    try {
      result = await worker.request(
        'task.run',
        { taskId, sessionId, taskType: 'check_state', packId: pack.id, url },
        { timeoutMs: TASK_TIMEOUT_MS, correlationId: run.correlation_id },
      );
    } catch (error) {
      this.finishTask(taskId, 'interrupted', null);
      if (error instanceof RpcError && error.problem.code === 'CONFLICT') {
        // The session is not under automation any more (the person took it): nothing to retry.
        return this.finish(run, 'cancelled');
      }
      this.d.logger.warn({ event: 'browser.task_failed', runId, err: error }, 'browser task failed');
      throw new RetryableError('browser_task_failed');
    }
    this.finishTask(taskId, result.status, result);
    const fresh = this.run(run.id);
    if (!fresh || fresh.status !== 'running') return; // cancelled while it ran

    if (result.status === 'succeeded') {
      // Closed first: the profile's status then follows the health found (e.g. needs sign-in).
      await this.d.browser.closeSession(sessionId);
      if (result.stateKind === 'login')
        this.d.browser.storeHealth(run.business_id, 'needs_login', result.stateId);
      else this.d.browser.storeHealth(run.business_id, 'healthy', result.stateId);
      this.d.audit.record({
        actorType: 'browser_worker',
        actionType: 'profile.checked',
        objectType: 'browser_profile',
        objectId: run.business_id,
        payload: { state: result.stateId, pack: `${pack.id}@${pack.version}` },
        correlationId: run.correlation_id,
      });
      return this.finish(run, 'completed');
    }
    if (result.status === 'needs_human' || result.status === 'unsupported_state') {
      // The worker already paused a challenge; an unknown page is paused here (docs/19).
      if (result.status === 'unsupported_state') await this.d.browser.setControlMode(sessionId, 'paused');
      else
        this.d.db.prepare(`UPDATE browser_sessions SET control_mode = 'paused' WHERE id = ?`).run(sessionId);
      this.request(
        run,
        sessionId,
        taskId,
        result.status === 'needs_human' ? 'security_challenge' : 'unsupported_state',
      );
      await this.d.browser.focusSession(sessionId).catch(() => {});
      return;
    }
    this.d.browser.storeHealth(run.business_id, 'unknown', result.errorKey);
    await this.d.browser.closeSession(sessionId);
    this.finish(run, 'failed');
  }

  private request(run: RunRow, sessionId: string, taskId: string, reason: InterventionReason): void {
    transaction(this.d.db, () => {
      const id = uuidv7();
      this.d.db
        .prepare(
          `INSERT INTO human_interventions (id, workflow_run_id, browser_session_id, browser_profile_id, browser_task_id,
                                            reason, status, requested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        )
        .run(id, run.id, sessionId, run.business_id, taskId, reason, this.d.now().toISOString());
      this.update(run.id, { status: 'waiting_for_human', state: 'WAITING_FOR_HUMAN' });
      this.d.audit.record({
        actorType: 'browser_worker',
        actionType: 'intervention.requested',
        objectType: 'browser_profile',
        objectId: run.business_id,
        payload: { reason },
        correlationId: run.correlation_id,
      });
    });
    this.d.changed(['browser', 'activity']);
  }

  // Interventions ------------------------------------------------------------------------------

  interventions(): Intervention[] {
    const rows = this.d.db
      .prepare(
        `SELECT i.*, p.name AS profile_name, s.status AS session_status, t.result AS task_result
         FROM human_interventions i
         LEFT JOIN browser_profiles p ON p.id = i.browser_profile_id
         LEFT JOIN browser_sessions s ON s.id = i.browser_session_id
         LEFT JOIN browser_tasks t ON t.id = i.browser_task_id
         WHERE i.status = 'open' ORDER BY i.requested_at`,
      )
      .all() as {
      id: string;
      reason: InterventionReason;
      browser_profile_id: string | null;
      profile_name: string | null;
      session_status: string | null;
      task_result: string | null;
      requested_at: string;
    }[];
    return rows.map((r) => {
      const result = r.task_result ? (JSON.parse(r.task_result) as TaskResult) : null;
      return {
        id: r.id,
        reason: r.reason,
        profileId: r.browser_profile_id,
        profileName: r.profile_name,
        sessionOpen: r.session_status === 'open',
        stateId: result?.stateId ?? null,
        url: result?.url ?? null,
        diagnostics: (result?.diagnostics ?? null) as TaskDiagnostics | null,
        requestedAt: r.requested_at,
      };
    });
  }

  /**
   * done: the person dealt with it — automation resumes in the same window and checks again (the
   * check is the revalidation). cancel: the run ends and the window closes.
   */
  async resolve(id: string, outcome: 'done' | 'cancel', ctx: CommandContext): Promise<void> {
    const row = this.d.db.prepare('SELECT * FROM human_interventions WHERE id = ?').get(id) as
      | {
          id: string;
          workflow_run_id: string;
          browser_session_id: string | null;
          status: string;
          browser_profile_id: string | null;
        }
      | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'Request not found', 'intervention.notFound');
    if (row.status !== 'open') throw conflict('intervention.closed');
    const run = this.run(row.workflow_run_id);
    const session = row.browser_session_id ? this.d.browser.sessionById(row.browser_session_id) : null;
    if (outcome === 'done' && session?.status === 'open') {
      await this.d.browser.setControlMode(session.id, 'automation');
    }
    transaction(this.d.db, () => {
      this.d.db
        .prepare(`UPDATE human_interventions SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?`)
        .run(
          outcome === 'done' ? 'resolved' : 'cancelled',
          JSON.stringify({ outcome }),
          this.d.now().toISOString(),
          id,
        );
      this.d.audit.record({
        actorType: 'user',
        actionType: outcome === 'done' ? 'intervention.resolved' : 'intervention.cancelled',
        objectType: 'browser_profile',
        ...(row.browser_profile_id ? { objectId: row.browser_profile_id } : {}),
        correlationId: ctx.correlationId,
      });
      if (run && outcome === 'done' && session?.status === 'open') {
        this.update(run.id, { status: 'running', state: 'RUN_TASK' });
        this.d.jobs.enqueue(JOB_BROWSER_CHECK, { runId: run.id }, { correlationId: ctx.correlationId });
      } else if (run) {
        this.finish(run, 'cancelled');
      }
    });
    if (outcome === 'cancel' && session?.status === 'open') await this.d.browser.closeSession(session.id);
    this.d.changed(['browser', 'activity']);
  }

  /** The window closed or the worker went away: whatever waited on that session is over. */
  private sessionEnded(sessionId: string): void {
    const open = this.d.db
      .prepare(
        `SELECT id, workflow_run_id FROM human_interventions WHERE browser_session_id = ? AND status = 'open'`,
      )
      .all(sessionId) as { id: string; workflow_run_id: string }[];
    for (const i of open) {
      this.d.db
        .prepare(
          `UPDATE human_interventions SET status = 'cancelled', resolution = ?, resolved_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify({ outcome: 'session_ended' }), this.d.now().toISOString(), i.id);
      const run = this.run(i.workflow_run_id);
      if (run) this.finish(run, 'cancelled');
    }
  }

  // ------------------------------------------------------------------------------------------------

  private finish(run: RunRow, status: 'completed' | 'failed' | 'cancelled'): void {
    this.update(run.id, { status, state: status === 'completed' ? 'COMPLETE' : 'ENDED' });
    this.d.changed(['browser']);
  }

  private finishTask(taskId: string, status: string, result: TaskResult | null): void {
    this.d.db
      .prepare('UPDATE browser_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?')
      .run(status, result ? JSON.stringify(result) : null, this.d.now().toISOString(), taskId);
  }

  private update(
    id: string,
    fields: { status?: string; state?: string; context?: Record<string, unknown> },
  ): void {
    const sets = ['updated_at = ?'];
    const values: string[] = [this.d.now().toISOString()];
    if (fields.status) {
      sets.push('status = ?');
      values.push(fields.status);
    }
    if (fields.state) {
      sets.push('current_state = ?');
      values.push(fields.state);
    }
    if (fields.context) {
      sets.push('context = ?');
      values.push(JSON.stringify(fields.context));
    }
    this.d.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  private run(id: string): RunRow | undefined {
    return this.d.db
      .prepare(`SELECT * FROM workflow_runs WHERE id = ? AND workflow_type = ?`)
      .get(id, WORKFLOW_TYPE) as RunRow | undefined;
  }
}

const conflict = (detail: string) => new RpcError('CONFLICT', 'Not possible in the current state', detail);
