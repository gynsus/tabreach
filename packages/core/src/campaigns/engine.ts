import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  activeWindowSchema,
  campaignConfigSchema,
  stepSchema,
  uuidv7,
  type ActiveWindow,
  type CampaignStep,
  type ChangedEntity,
  type Condition,
  type Logger,
  type StopReason,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import type { ChannelResolver, MessageChannel } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import {
  PermanentError,
  RetryableError,
  type JobContext,
  type JobOutcome,
  type JobType,
} from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import { executeSideEffect } from '../ledger/execute.js';
import { intentKey, type IntentParts, type SideEffectLedger } from '../ledger/side-effects.js';
import type { ContactPolicy, PolicyVerdict } from './policy.js';
import { nextAllowedAt, recipientTimeZone } from './schedule.js';
import { renderTemplate } from './template.js';

export const JOB_ADVANCE = 'enrollment.advance';
export const JOB_RUN = 'workflow.run';
export const WORKFLOW_TYPE = 'campaign_message';
export const DEFINITION_VERSION = 1;

/** States of one message step (docs/13, "Example"), minus the browser-only ones. */
export type RunState =
  'PREPARE_CONTENT' | 'CHECK_POLICY' | 'CHECK_APPROVAL' | 'FINAL_PRE_SEND_CHECK' | 'SEND' | 'COMPLETE';
export type RunStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'waiting_for_human'
  | 'waiting_external'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';
const TERMINAL: ReadonlySet<RunStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface EnrollmentRow {
  id: string;
  campaign_id: string;
  campaign_version_id: string;
  company_id: string | null;
  contact_id: string;
  status: 'active' | 'paused' | 'completed' | 'stopped';
  current_step_position: number;
  next_action_at: string | null;
  stop_reason: StopReason | null;
  lock_version: number;
  created_at: string;
  updated_at: string;
}

export interface RunRow {
  id: string;
  business_id: string;
  step_position: number;
  status: RunStatus;
  current_state: RunState;
  correlation_id: string;
  lock_version: number;
}

export interface DraftRow {
  id: string;
  workflow_run_id: string;
  campaign_enrollment_id: string;
  contact_id: string;
  channel: string;
  subject: string | null;
  body: string;
  content_hash: string;
  version: number;
}

export interface ApprovalRow {
  id: string;
  workflow_run_id: string;
  campaign_enrollment_id: string;
  message_draft_id: string;
  draft_version: number;
  target_snapshot: string;
  content_hash: string;
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'superseded' | 'expired';
  created_at: string;
}

interface ContactFacts {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  job_title: string | null;
  email_normalized: string | null;
  timezone: string | null;
  company_id: string | null;
  company_name: string | null;
  company_city: string | null;
  company_country: string | null;
  company_domain: string | null;
  company_timezone: string | null;
}

/** Version settings frozen at launch (steps live in sequence_steps). */
export const versionConfigSchema = campaignConfigSchema.omit({ steps: true });
export type VersionConfig = z.infer<typeof versionConfigSchema>;

type SendStep = Extract<CampaignStep, { type: 'send_message' }>;

export interface CampaignEngineDeps {
  db: DatabaseSync;
  now: () => Date;
  audit: AuditLog;
  jobs: JobQueue;
  ledger: SideEffectLedger;
  policy: ContactPolicy;
  channels: ChannelResolver;
  logger: Logger;
  changed: (entities: ChangedEntity[]) => void;
}

/** Thrown by the pre-send guard to block a send without touching the ledger. */
class PolicyBlocked extends Error {
  constructor(readonly verdict: Exclude<PolicyVerdict, { kind: 'ok' }>) {
    super(verdict.rule);
  }
}

export function contentHash(channel: string, target: string, subject: string | null, body: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['v1', channel, target, subject, body]))
    .digest('hex');
}

/**
 * Runs campaigns (docs/13, docs/17, ADR 021). Two job types:
 * - `enrollment.advance` moves an enrollment through its steps; it owns the delays between them;
 * - `workflow.run` drives one message step through prepare → policy → approval → send.
 * Each handler reloads state first, so any number of stray or duplicate jobs is harmless.
 */
export class CampaignEngine {
  constructor(private readonly d: CampaignEngineDeps) {}

  jobTypes(): JobType<never>[] {
    const advance: JobType<{ enrollmentId: string }> = {
      type: JOB_ADVANCE,
      payload: z.object({ enrollmentId: z.uuid() }),
      sideEffecting: false,
      concurrency: 4,
      maxAttempts: 5,
      handler: ({ enrollmentId }, ctx) => this.advance(enrollmentId, ctx),
    };
    const run: JobType<{ runId: string }> = {
      type: JOB_RUN,
      payload: z.object({ runId: z.uuid() }),
      sideEffecting: true,
      // One send at a time keeps channel pacing exact; there is one test channel account in Phase 2.
      concurrency: 1,
      maxAttempts: 6,
      maxAgeMs: 7 * 24 * 60 * 60_000,
      handler: ({ runId }, ctx) => this.runStep(runId, ctx),
    };
    return [advance, run] as unknown as JobType<never>[];
  }

  scheduleEnrollment(enrollmentId: string, at: Date): void {
    this.d.jobs.enqueue(
      JOB_ADVANCE,
      { enrollmentId },
      { runAt: at, dedupeKey: `enrollment:${enrollmentId}` },
    );
  }

  wakeRun(runId: string, correlationId?: string): void {
    this.d.jobs.enqueue(
      JOB_RUN,
      { runId },
      { dedupeKey: `run:${runId}`, ...(correlationId ? { correlationId } : {}) },
    );
  }

  /**
   * Makes sure every live enrollment and run has a job (core start, campaign or enrollment
   * resume). Dedupe keys make it idempotent.
   */
  resync(filter: { campaignId?: string; enrollmentId?: string } = {}): void {
    transaction(this.d.db, () => {
      const where = ["e.status = 'active'", "c.status = 'active'"];
      const params: string[] = [];
      if (filter.campaignId) {
        where.push('e.campaign_id = ?');
        params.push(filter.campaignId);
      }
      if (filter.enrollmentId) {
        where.push('e.id = ?');
        params.push(filter.enrollmentId);
      }
      const enrollments = this.d.db
        .prepare(
          `SELECT e.id, e.next_action_at FROM campaign_enrollments e JOIN campaigns c ON c.id = e.campaign_id
           WHERE ${where.join(' AND ')}`,
        )
        .all(...params) as { id: string; next_action_at: string | null }[];
      for (const e of enrollments) {
        const run = this.openRun(e.id);
        if (!run) {
          this.scheduleEnrollment(e.id, e.next_action_at ? new Date(e.next_action_at) : this.d.now());
        } else if (run.status === 'paused' || run.status === 'pending' || run.status === 'running') {
          if (run.status === 'paused') this.updateRun(run, { status: 'running' });
          this.wakeRun(run.id, run.correlation_id);
        }
      }
    });
  }

  // enrollment.advance ---------------------------------------------------------------------

  advance(enrollmentId: string, ctx: Pick<JobContext, 'correlationId'>): JobOutcome {
    return transaction(this.d.db, () => {
      // Condition steps that are due right away are walked through in one go.
      for (let hop = 0; hop < 25; hop++) {
        const e = this.enrollment(enrollmentId);
        if (!e || e.status !== 'active' || this.campaignStatus(e.campaign_id) !== 'active') return;
        const now = this.d.now();
        if (e.next_action_at && new Date(e.next_action_at) > now)
          return { continueAt: new Date(e.next_action_at) };
        const open = this.openRun(e.id);
        if (open) {
          // The run drives the step; make sure it is not stranded.
          if (open.status === 'pending' || open.status === 'running')
            this.wakeRun(open.id, open.correlation_id);
          return;
        }
        const step = this.step(e.campaign_version_id, e.current_step_position);
        if (!step) {
          this.completeEnrollment(e, ctx.correlationId);
          return;
        }
        if (step.type === 'condition') {
          const facts = this.contact(e.contact_id);
          const holds = facts !== undefined && this.conditionsHold(step.conditions, facts);
          if (!holds && step.onFalse === 'stop') {
            this.stopEnrollment(e, 'condition_not_met', ctx.correlationId, 'system');
            return;
          }
          const next = this.finishStep(e, ctx.correlationId);
          if (!next) return;
          if (next > now) return { continueAt: next };
          continue;
        }
        const runId = uuidv7();
        const ts = now.toISOString();
        this.d.db
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_type, definition_version, business_type, business_id, step_position,
                                      status, current_state, context, correlation_id, created_at, updated_at)
           VALUES (?, ?, ?, 'enrollment', ?, ?, 'running', 'PREPARE_CONTENT', '{}', ?, ?, ?)`,
          )
          .run(
            runId,
            WORKFLOW_TYPE,
            DEFINITION_VERSION,
            e.id,
            e.current_step_position,
            ctx.correlationId,
            ts,
            ts,
          );
        this.wakeRun(runId, ctx.correlationId);
        return;
      }
      throw new PermanentError('step_loop', 'Too many consecutive condition steps');
    });
  }

  // workflow.run ---------------------------------------------------------------------------

  async runStep(runId: string, ctx: JobContext): Promise<JobOutcome> {
    // Each pass handles one state; SEND is the only one that awaits.
    for (let pass = 0; pass < 12; pass++) {
      const run = this.run(runId);
      if (!run || TERMINAL.has(run.status) || run.status === 'waiting_approval') return;
      const e = this.enrollment(run.business_id);
      if (!e || e.status === 'stopped' || e.status === 'completed') {
        transaction(this.d.db, () => this.cancelRun(run));
        return;
      }
      if (e.status === 'paused' || this.campaignStatus(e.campaign_id) !== 'active') {
        this.updateRun(run, { status: 'paused' });
        this.d.changed(['enrollment']);
        return;
      }
      const step = this.step(e.campaign_version_id, run.step_position);
      if (!step || step.type !== 'send_message') throw new PermanentError('step_missing');
      const outcome =
        run.current_state === 'SEND'
          ? await this.send(run, e, step, ctx)
          : transaction(this.d.db, () => this.syncState(run, e, step, run.correlation_id));
      if (outcome !== 'next') return outcome === 'done' ? undefined : outcome;
    }
    throw new RetryableError('state_loop', 'Workflow did not settle');
  }

  /** One synchronous state. Returns 'next' to keep going, 'done' to stop, or when to come back. */
  private syncState(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    correlationId: string,
  ): 'next' | 'done' | { continueAt: Date } {
    const facts = this.contact(e.contact_id);
    if (!facts) {
      this.stopEnrollment(e, 'invalid_target', correlationId, 'system');
      return 'done';
    }
    const target = facts.email_normalized;
    switch (run.current_state) {
      case 'PREPARE_CONTENT': {
        if (!target) {
          this.stopEnrollment(e, 'invalid_target', correlationId, 'system');
          return 'done';
        }
        if (!this.latestDraft(run.id)) {
          const values = templateValues(facts);
          const subject = renderTemplate(step.subject, values);
          const body = renderTemplate(step.body, values);
          const missing = [...new Set([...subject.missing, ...body.missing])];
          if (missing.length > 0) {
            this.stopEnrollment(e, 'missing_data', correlationId, 'system', { fields: missing });
            return 'done';
          }
          this.insertDraft(run, e, step.channel, target, subject.text || null, body.text, 1);
        }
        this.updateRun(run, { current_state: 'CHECK_POLICY' });
        return 'next';
      }
      case 'CHECK_POLICY': {
        const verdict = this.policyVerdict(e, run, step, facts, target);
        if (verdict.kind === 'stop') {
          this.stopEnrollment(e, verdict.reason, correlationId, 'system', { rule: verdict.rule });
          return 'done';
        }
        if (verdict.kind === 'defer') return { continueAt: verdict.until };
        this.updateRun(run, { current_state: 'CHECK_APPROVAL' });
        return 'next';
      }
      case 'CHECK_APPROVAL': {
        const draft = this.latestDraft(run.id);
        if (!draft) {
          this.updateRun(run, { current_state: 'PREPARE_CONTENT' });
          return 'next';
        }
        const approval = this.currentApproval(run.id);
        if (!approval || approval.message_draft_id !== draft.id) {
          if (approval) this.closeApprovals(run.id, 'superseded');
          this.requestApproval(run, e, draft, correlationId);
          this.updateRun(run, { status: 'waiting_approval' });
          return 'done';
        }
        switch (approval.status) {
          case 'pending':
            this.updateRun(run, { status: 'waiting_approval' });
            return 'done';
          case 'approved':
            this.updateRun(run, { current_state: 'FINAL_PRE_SEND_CHECK' });
            return 'next';
          case 'rejected':
            this.stopEnrollment(e, 'rejected', correlationId, 'user');
            return 'done';
          case 'skipped':
            this.updateRun(run, { status: 'completed', current_state: 'COMPLETE' });
            this.finishStep(e, correlationId);
            return 'done';
          default:
            throw new PermanentError('approval_state', `Unexpected approval status ${approval.status}`);
        }
      }
      case 'FINAL_PRE_SEND_CHECK': {
        const draft = this.latestDraft(run.id);
        const approval = this.currentApproval(run.id);
        const hash = draft && target ? contentHash(step.channel, target, draft.subject, draft.body) : null;
        if (!draft || !approval || approval.status !== 'approved' || approval.content_hash !== hash) {
          // The draft or the recipient changed after approval: ask again (APPROVAL_STALE, ADR 021 §4).
          this.closeApprovals(run.id, 'superseded');
          if (draft && target && hash !== draft.content_hash) {
            this.insertDraft(run, e, step.channel, target, draft.subject, draft.body, draft.version + 1);
          }
          this.updateRun(run, { current_state: 'CHECK_APPROVAL' });
          return 'next';
        }
        const channel = this.channelFor(e, step);
        const pacing = this.d.policy.checkChannel(channel, this.intentKeyFor(e, run, step, target as string));
        if (pacing.kind === 'defer') return { continueAt: pacing.until };
        this.updateRun(run, { current_state: 'SEND' });
        return 'next';
      }
      default:
        throw new PermanentError('run_state', `Unexpected state ${run.current_state}`);
    }
  }

  private async send(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    ctx: JobContext,
  ): Promise<'next' | 'done' | { continueAt: Date }> {
    const channel = this.channelFor(e, step);
    const draft = this.latestDraft(run.id);
    const facts = this.contact(e.contact_id);
    const approval = this.currentApproval(run.id);
    if (!draft || !facts?.email_normalized || !approval) {
      transaction(this.d.db, () => this.updateRun(run, { current_state: 'FINAL_PRE_SEND_CHECK' }));
      return 'next';
    }
    const target = facts.email_normalized;
    const intent: IntentParts = {
      scopeId: e.id,
      stepPosition: run.step_position,
      channel: step.channel,
      actionType: 'send_message',
      target,
    };
    const hash = contentHash(step.channel, target, draft.subject, draft.body);
    const audit = (
      status: 'planned' | 'completed' | 'failed' | 'unknown',
      extra: Record<string, unknown> = {},
    ) =>
      this.d.audit.record({
        actorType: 'system',
        actionType: 'message.send',
        objectType: 'enrollment',
        objectId: e.id,
        status,
        payload: {
          runId: run.id,
          step: run.step_position,
          channel: step.channel,
          attempt: ctx.attempt,
          ...extra,
        },
        correlationId: run.correlation_id,
      });

    let outcome;
    try {
      outcome = await executeSideEffect({
        ledger: this.d.ledger,
        channel,
        intent,
        workflowRunId: run.id,
        message: {
          target,
          recipientName: templateValues(facts).fullName,
          subject: draft.subject,
          body: draft.body,
          contentHash: hash,
        },
        signal: ctx.signal,
        guard: () => {
          // Final pre-send check, in the reserving transaction (ADR 021 §6).
          if (approval.status !== 'approved' || approval.content_hash !== hash) {
            throw new PolicyBlocked({ kind: 'defer', until: this.d.now(), rule: 'approval.stale' });
          }
          const verdict = this.policyVerdict(e, run, step, facts, target);
          if (verdict.kind !== 'ok') throw new PolicyBlocked(verdict);
          const pacing = this.d.policy.checkChannel(channel, intentKey(intent));
          if (pacing.kind !== 'ok') throw new PolicyBlocked(pacing);
          audit('planned');
        },
      });
    } catch (error) {
      if (!(error instanceof PolicyBlocked)) throw error;
      return transaction(this.d.db, () => {
        const fresh = this.run(run.id);
        const freshEnrollment = this.enrollment(e.id);
        if (!fresh || !freshEnrollment) return 'done';
        const v = error.verdict;
        if (v.kind === 'stop') {
          this.stopEnrollment(freshEnrollment, v.reason, run.correlation_id, 'system', { rule: v.rule });
          return 'done';
        }
        if (v.rule === 'approval.stale') {
          this.updateRun(fresh, { current_state: 'FINAL_PRE_SEND_CHECK' });
          return 'next';
        }
        return { continueAt: v.until };
      });
    }

    if (outcome.outcome === 'pending') {
      // Reconciliation cannot tell yet (the Sent search lags): look again later, not a failure.
      return { continueAt: outcome.retryAt };
    }
    if (outcome.outcome === 'not_sent' && outcome.permanent) {
      return transaction(this.d.db, () => {
        this.recordSendAttempt(run.id, ctx.attempt, outcome);
        audit('failed', { errorClass: outcome.errorClass, permanent: true });
        const fresh = this.enrollment(e.id);
        if (fresh && (fresh.status === 'active' || fresh.status === 'paused')) {
          this.stopEnrollment(fresh, 'send_failed', run.correlation_id, 'system', {
            errorClass: outcome.errorClass,
          });
        }
        return 'done';
      });
    }
    if (outcome.outcome !== 'completed') {
      transaction(this.d.db, () => {
        this.recordSendAttempt(run.id, ctx.attempt, outcome);
        audit(outcome.outcome === 'unknown' ? 'unknown' : 'failed', { errorClass: outcome.errorClass });
      });
      this.d.changed(['activity']);
      // not_sent: safe to try again. unknown: possibly delivered — the retry reconciles with the
      // channel through the ledger, it never re-sends blindly.
      throw new RetryableError(
        outcome.outcome === 'unknown' ? 'send_unknown' : 'send_not_sent',
        outcome.errorClass,
      );
    }

    return transaction(this.d.db, () => {
      this.recordSendAttempt(run.id, ctx.attempt, outcome);
      audit('completed', { alreadyDone: outcome.alreadyDone });
      const fresh = this.run(run.id);
      const freshEnrollment = this.enrollment(e.id);
      if (fresh && !TERMINAL.has(fresh.status))
        this.updateRun(fresh, { status: 'completed', current_state: 'COMPLETE' });
      if (freshEnrollment?.status === 'active' || freshEnrollment?.status === 'paused') {
        this.finishStep(freshEnrollment, run.correlation_id);
      }
      this.d.changed(['enrollment', 'activity']);
      return 'done';
    });
  }

  // Enrollment transitions -----------------------------------------------------------------

  /** The step is done: move to the next one (delay from now, into the recipient's window) or complete. */
  finishStep(e: EnrollmentRow, correlationId: string): Date | null {
    const nextPosition = e.current_step_position + 1;
    const next = this.step(e.campaign_version_id, nextPosition);
    if (!next) {
      this.completeEnrollment({ ...e, current_step_position: nextPosition }, correlationId);
      return null;
    }
    const facts = this.contact(e.contact_id);
    const due = new Date(this.d.now().getTime() + next.delaySeconds * 1000);
    const at =
      next.type === 'send_message' && facts
        ? nextAllowedAt(due, this.timeZoneFor(e, facts), this.windowFor(e.campaign_version_id))
        : due;
    this.updateEnrollment(e, { current_step_position: nextPosition, next_action_at: at.toISOString() });
    if (e.status === 'active') this.scheduleEnrollment(e.id, at);
    this.d.changed(['enrollment']);
    return e.status === 'active' ? at : null;
  }

  private completeEnrollment(e: EnrollmentRow, correlationId: string): void {
    this.updateEnrollment(e, {
      status: 'completed',
      current_step_position: e.current_step_position,
      next_action_at: null,
    });
    this.d.audit.record({
      actorType: 'system',
      actionType: 'enrollment.completed',
      objectType: 'enrollment',
      objectId: e.id,
      correlationId,
    });
    this.d.changed(['enrollment', 'campaign', 'activity']);
  }

  /** Terminal stop: cancels the open run and closes its approvals. */
  stopEnrollment(
    e: EnrollmentRow,
    reason: StopReason,
    correlationId: string,
    actor: 'user' | 'system',
    detail: Record<string, unknown> = {},
  ): void {
    const run = this.openRun(e.id);
    if (run) this.cancelRun(run);
    this.updateEnrollment(e, { status: 'stopped', stop_reason: reason, next_action_at: null });
    this.d.audit.record({
      actorType: actor,
      actionType: 'enrollment.stopped',
      objectType: 'enrollment',
      objectId: e.id,
      payload: { reason, ...detail },
      correlationId,
    });
    this.d.changed(['enrollment', 'approval', 'campaign', 'activity']);
  }

  private cancelRun(run: RunRow): void {
    this.closeApprovals(run.id, 'expired');
    this.updateRun(run, { status: 'cancelled' });
  }

  // Approvals and drafts -------------------------------------------------------------------

  requestApproval(run: RunRow, e: EnrollmentRow, draft: DraftRow, correlationId: string): string {
    const id = uuidv7();
    const target = this.contact(e.contact_id)?.email_normalized ?? '';
    this.d.db
      .prepare(
        `INSERT INTO approvals (id, workflow_run_id, campaign_enrollment_id, message_draft_id, draft_version,
                                target_snapshot, content_hash, scope, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'single_action', 'pending', ?)`,
      )
      .run(
        id,
        run.id,
        e.id,
        draft.id,
        draft.version,
        JSON.stringify({ channel: draft.channel, target, contactId: e.contact_id }),
        draft.content_hash,
        this.d.now().toISOString(),
      );
    this.d.audit.record({
      actorType: 'system',
      actionType: 'approval.requested',
      objectType: 'approval',
      objectId: id,
      payload: { enrollmentId: e.id, draftVersion: draft.version },
      correlationId,
    });
    this.d.changed(['approval', 'enrollment']);
    return id;
  }

  insertDraft(
    run: RunRow,
    e: EnrollmentRow,
    channel: string,
    target: string,
    subject: string | null,
    body: string,
    version: number,
  ): DraftRow {
    const id = uuidv7();
    this.d.db
      .prepare(
        `INSERT INTO message_drafts (id, contact_id, company_id, campaign_enrollment_id, workflow_run_id, channel,
                                     subject, body, content_hash, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        e.contact_id,
        e.company_id,
        e.id,
        run.id,
        channel,
        subject,
        body,
        contentHash(channel, target, subject, body),
        version,
        this.d.now().toISOString(),
      );
    return this.d.db.prepare('SELECT * FROM message_drafts WHERE id = ?').get(id) as unknown as DraftRow;
  }

  closeApprovals(runId: string, status: 'superseded' | 'expired'): void {
    this.d.db
      .prepare(
        `UPDATE approvals SET status = ? WHERE workflow_run_id = ? AND status IN ('pending', 'approved')`,
      )
      .run(status, runId);
  }

  latestDraft(runId: string): DraftRow | undefined {
    return this.d.db
      .prepare('SELECT * FROM message_drafts WHERE workflow_run_id = ? ORDER BY version DESC LIMIT 1')
      .get(runId) as DraftRow | undefined;
  }

  /** The newest approval that still counts (not superseded or expired). */
  currentApproval(runId: string): ApprovalRow | undefined {
    return this.d.db
      .prepare(
        `SELECT * FROM approvals WHERE workflow_run_id = ? AND status NOT IN ('superseded', 'expired')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(runId) as ApprovalRow | undefined;
  }

  // Reads ----------------------------------------------------------------------------------

  enrollment(id: string): EnrollmentRow | undefined {
    return this.d.db.prepare('SELECT * FROM campaign_enrollments WHERE id = ?').get(id) as
      EnrollmentRow | undefined;
  }

  run(id: string): RunRow | undefined {
    return this.d.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  openRun(enrollmentId: string): RunRow | undefined {
    return this.d.db
      .prepare(
        `SELECT * FROM workflow_runs WHERE business_type = 'enrollment' AND business_id = ?
           AND status NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(enrollmentId) as RunRow | undefined;
  }

  step(versionId: string, position: number): CampaignStep | undefined {
    const row = this.d.db
      .prepare('SELECT config FROM sequence_steps WHERE campaign_version_id = ? AND position = ?')
      .get(versionId, position) as { config: string } | undefined;
    return row ? stepSchema.parse(JSON.parse(row.config)) : undefined;
  }

  stepCount(versionId: string): number {
    return (
      this.d.db
        .prepare('SELECT COUNT(*) AS n FROM sequence_steps WHERE campaign_version_id = ?')
        .get(versionId) as {
        n: number;
      }
    ).n;
  }

  versionConfig(versionId: string): VersionConfig {
    const row = this.d.db.prepare('SELECT config FROM campaign_versions WHERE id = ?').get(versionId) as {
      config: string;
    };
    return versionConfigSchema.parse(JSON.parse(row.config));
  }

  windowFor(versionId: string): ActiveWindow {
    return this.versionConfig(versionId).window ?? activeWindowSchema.parse(this.d.policy.current().window);
  }

  timeZoneFor(e: EnrollmentRow, facts: ContactFacts): string {
    return recipientTimeZone(
      facts.timezone,
      facts.company_timezone,
      this.versionConfig(e.campaign_version_id).timezone,
    );
  }

  /** When a new enrollment's first step may start. */
  firstActionAt(versionId: string, contactId: string): Date {
    const first = this.step(versionId, 1);
    const due = new Date(this.d.now().getTime() + (first?.delaySeconds ?? 0) * 1000);
    const facts = this.contact(contactId);
    if (!first || first.type !== 'send_message' || !facts) return due;
    const tz = recipientTimeZone(
      facts.timezone,
      facts.company_timezone,
      this.versionConfig(versionId).timezone,
    );
    return nextAllowedAt(due, tz, this.windowFor(versionId));
  }

  contact(id: string): ContactFacts | undefined {
    return this.d.db
      .prepare(
        `SELECT c.id, c.first_name, c.last_name, c.full_name, c.job_title, c.email_normalized, c.timezone, c.company_id,
                co.name AS company_name, co.city AS company_city, co.country AS company_country,
                co.domain_normalized AS company_domain, co.timezone AS company_timezone
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = ?`,
      )
      .get(id) as ContactFacts | undefined;
  }

  private campaignStatus(id: string): string | undefined {
    return (
      this.d.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string } | undefined
    )?.status;
  }

  private policyVerdict(
    e: EnrollmentRow,
    run: RunRow,
    step: SendStep,
    facts: ContactFacts,
    target: string | null,
  ): PolicyVerdict {
    return this.d.policy.check({
      contactId: e.contact_id,
      companyId: facts.company_id,
      idempotencyKey: this.intentKeyFor(e, run, step, target ?? ''),
      timeZone: this.timeZoneFor(e, facts),
      window: this.windowFor(e.campaign_version_id),
    });
  }

  private channelFor(e: EnrollmentRow, step: SendStep): MessageChannel {
    const channel = this.d.channels(step.channel, this.versionConfig(e.campaign_version_id));
    if (!channel) throw new PermanentError('channel_unavailable');
    return channel;
  }

  private intentKeyFor(e: EnrollmentRow, run: RunRow, step: SendStep, target: string): string {
    return intentKey({
      scopeId: e.id,
      stepPosition: run.step_position,
      channel: step.channel,
      actionType: 'send_message',
      target,
    });
  }

  private conditionsHold(conditions: Condition[], facts: ContactFacts): boolean {
    const tags = (sql: string, id: string | null) =>
      id ? (this.d.db.prepare(sql).all(id) as { name: string }[]).map((t) => t.name) : [];
    const value = (field: Condition['field']): string | string[] | null => {
      switch (field) {
        case 'contact.firstName':
          return facts.first_name;
        case 'contact.lastName':
          return facts.last_name;
        case 'contact.jobTitle':
          return facts.job_title;
        case 'contact.email':
          return facts.email_normalized;
        case 'contact.tags':
          return tags(
            'SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = ?',
            facts.id,
          );
        case 'company.name':
          return facts.company_name;
        case 'company.domain':
          return facts.company_domain;
        case 'company.country':
          return facts.company_country;
        case 'company.city':
          return facts.company_city;
        case 'company.tags':
          return tags(
            'SELECT t.name FROM company_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.company_id = ?',
            facts.company_id,
          );
      }
    };
    return conditions.every((c) => evaluateCondition(c, value(c.field)));
  }

  private recordSendAttempt(
    runId: string,
    attempt: number,
    outcome: { outcome: string; sideEffectId: string },
  ): void {
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO workflow_step_runs (id, workflow_run_id, state, attempt, status, result, started_at, completed_at, error_code)
         VALUES (?, ?, 'SEND', ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workflow_run_id, state, attempt) DO UPDATE SET status = excluded.status, result = excluded.result,
           completed_at = excluded.completed_at, error_code = excluded.error_code`,
      )
      .run(
        uuidv7(),
        runId,
        attempt,
        outcome.outcome === 'completed' ? 'succeeded' : 'failed',
        JSON.stringify(outcome),
        ts,
        ts,
        outcome.outcome === 'completed' ? null : outcome.outcome,
      );
  }

  updateRun(run: RunRow, fields: Partial<Pick<RunRow, 'status' | 'current_state'>>): void {
    const entries = Object.entries(fields);
    const result = this.d.db
      .prepare(
        `UPDATE workflow_runs SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, lock_version = lock_version + 1,
                updated_at = ?
         WHERE id = ? AND lock_version = ?`,
      )
      .run(...entries.map(([, v]) => v as string), this.d.now().toISOString(), run.id, run.lock_version);
    if (Number(result.changes) !== 1)
      throw new RetryableError('lock_conflict', `Run ${run.id} changed concurrently`);
    Object.assign(run, fields, { lock_version: run.lock_version + 1 });
  }

  updateEnrollment(
    e: EnrollmentRow,
    fields: Partial<
      Pick<EnrollmentRow, 'status' | 'current_step_position' | 'next_action_at' | 'stop_reason'>
    >,
  ): void {
    const entries = Object.entries(fields);
    const result = this.d.db
      .prepare(
        `UPDATE campaign_enrollments SET ${entries.map(([k]) => `${k} = ?`).join(', ')},
                lock_version = lock_version + 1, updated_at = ?
         WHERE id = ? AND lock_version = ?`,
      )
      .run(
        ...entries.map(([, v]) => v as string | number | null),
        this.d.now().toISOString(),
        e.id,
        e.lock_version,
      );
    if (Number(result.changes) !== 1)
      throw new RetryableError('lock_conflict', `Enrollment ${e.id} changed concurrently`);
    Object.assign(e, fields, { lock_version: e.lock_version + 1 });
  }
}

function templateValues(f: ContactFacts) {
  const joined = [f.first_name, f.last_name].filter(Boolean).join(' ');
  return {
    firstName: f.first_name,
    lastName: f.last_name,
    fullName: f.full_name ?? (joined || null),
    jobTitle: f.job_title,
    companyName: f.company_name,
    companyCity: f.company_city,
    companyCountry: f.company_country,
  };
}

const fold = (s: string) => s.normalize('NFC').toLocaleLowerCase().trim();

export function evaluateCondition(c: Condition, actual: string | string[] | null): boolean {
  const values = (Array.isArray(actual) ? actual : actual ? [actual] : []).map(fold).filter(Boolean);
  const expected = fold(c.value ?? '');
  switch (c.op) {
    case 'exists':
      return values.length > 0;
    case 'not_exists':
      return values.length === 0;
    case 'eq':
      return values.some((v) => v === expected);
    case 'neq':
      return !values.some((v) => v === expected);
    case 'contains':
      return Array.isArray(actual) ? values.includes(expected) : values.some((v) => v.includes(expected));
  }
}
