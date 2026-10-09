import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  activeWindowSchema,
  campaignConfigSchema,
  stepSchema,
  uuidv7,
  type ActiveWindow,
  type BrowserExecutionMode,
  type CampaignStep,
  type ChangedEntity,
  type Condition,
  type DraftOrigin,
  type Logger,
  type StopReason,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import type { ChannelResolver, MessageChannel } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import { allPassed, runDraftChecks } from '../drafts/checks.js';
import { cleanDraftBody, cleanSubject, type DraftRequest, type DraftResult } from '../drafts/draft-writer.js';
import {
  PermanentError,
  RetryableError,
  type JobContext,
  type JobOutcome,
  type JobType,
} from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import { websiteTarget, type FormPreparationRow, type PrepareOutcome } from '../forms/form-service.js';
import { executeSideEffect } from '../ledger/execute.js';
import { intentKey, type IntentParts, type SideEffectLedger } from '../ledger/side-effects.js';
import type { ContactPolicy, PolicyVerdict } from './policy.js';
import { nextAllowedAt, recipientTimeZone } from './schedule.js';
import { renderTemplate } from './template.js';

export const JOB_ADVANCE = 'enrollment.advance';
export const JOB_RUN = 'workflow.run';
export const WORKFLOW_TYPE = 'campaign_message';
export const DEFINITION_VERSION = 1;

/**
 * States of one message step (docs/13, "Example"), minus the browser-only ones. GENERATE_DRAFT:
 * an AI step waits for research and the model (it awaits, like SEND).
 */
export type RunState =
  | 'PREPARE_CONTENT'
  | 'GENERATE_DRAFT'
  | 'CHECK_POLICY'
  /** Website forms: find, map, fill and photograph the form before approval (Phase 6). */
  | 'PREPARE_FORM'
  | 'CHECK_APPROVAL'
  | 'FINAL_PRE_SEND_CHECK'
  | 'SEND'
  | 'COMPLETE';
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
  origin: DraftOrigin;
  fact_ids: string;
}

/** Who wrote a draft version and from what (stored with it). */
export interface DraftMeta {
  origin: DraftOrigin;
  factIds?: string[];
  generation?: Record<string, unknown>;
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
  company_website: string | null;
  company_timezone: string | null;
  /** Normalized LinkedIn profile (`linkedin.com/in/<slug>`), if the contact has one. */
  linkedin_url: string | null;
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
  /**
   * Runs before a send leaves (before the ledger reservation): e.g. read the email inbox first so
   * a reply that already arrived stops the sequence. May throw a RetryableError to wait.
   */
  beforeSend?: (channel: MessageChannel, signal: AbortSignal, correlationId: string) => Promise<void>;
  /** App-wide pause (docs/19): no send starts while it is on; it waits and goes out after. */
  paused?: () => boolean;
  /** Writes AI drafts (Phase 4c). Without it, an AI step stops with `draft_failed`. */
  drafter?: { write(req: DraftRequest, signal: AbortSignal, correlationId: string): Promise<DraftResult> };
  /** Website forms (Phase 6): preparing before approval, and what an approval of a form covers. */
  forms?: {
    prepare(req: {
      workflowRunId: string;
      draftId: string;
      website: string;
      subject: string | null;
      body: string;
      stepMode: BrowserExecutionMode;
      forceAssisted: boolean;
      signal: AbortSignal;
      correlationId: string;
    }): Promise<PrepareOutcome>;
    latestFor(runId: string): FormPreparationRow | undefined;
    isCurrent(preparation: FormPreparationRow): boolean;
    crossSite(preparation: FormPreparationRow): boolean;
    approvalHash(draftHash: string, preparation: FormPreparationRow): string;
    requireAssisted(preparationId: string): void;
  };
  /** Told about every completed send (in its transaction), e.g. to thread replies to it. */
  onSent?: (sent: {
    channel: string;
    accountId: string | null;
    enrollmentId: string;
    contactId: string;
    companyId: string | null;
    idempotencyKey: string;
    subject: string | null;
    body: string;
    externalRefs: Record<string, unknown>;
  }) => void;
}

/** Thrown by the pre-send guard to block a send without touching the ledger. */
class PolicyBlocked extends Error {
  constructor(readonly verdict: Exclude<PolicyVerdict, { kind: 'ok' }>) {
    super(verdict.rule);
  }
}

/** The ledger's action class: LinkedIn invitations and messages have their own limits (FR-LIN-005). */
export function actionTypeOf(step: SendStep): string {
  return step.channel === 'linkedin' ? `linkedin.${step.linkedinAction}` : 'send_message';
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
      // Two at a time: a form waiting for the person to press Send must not hold up email. Each
      // channel account still sends one at a time (the lock in send()), so pacing stays exact.
      concurrency: 2,
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
        } else if (this.runNeedsAttention(run.id)) {
          // Its job failed or died: it waits in "Needs attention" until a person retries it.
          continue;
        } else if (run.status === 'paused' || run.status === 'pending' || run.status === 'running') {
          if (run.status === 'paused') this.updateRun(run, { status: 'running' });
          this.wakeRun(run.id, run.correlation_id);
        }
      }
    });
  }

  private runNeedsAttention(runId: string): boolean {
    const job = this.d.jobs.latestFor(JOB_RUN, 'runId', runId);
    return job?.status === 'dead' || job?.status === 'failed';
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
          if ((open.status === 'pending' || open.status === 'running') && !this.runNeedsAttention(open.id)) {
            this.wakeRun(open.id, open.correlation_id);
          }
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
          let next = this.finishStep(e, ctx.correlationId);
          // "Skip": the condition guards the step after it; that step is left out (audit 3.5).
          if (!holds && next !== null) next = this.finishStep(e, ctx.correlationId);
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
          : run.current_state === 'GENERATE_DRAFT'
            ? await this.generate(run, e, step, ctx)
            : run.current_state === 'PREPARE_FORM'
              ? await this.prepareForm(run, e, step, ctx)
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
    const target = this.targetFor(step.channel, facts);
    switch (run.current_state) {
      case 'PREPARE_CONTENT': {
        // LinkedIn checks the page names this person (FR-LIN-003): without a name nothing is sent.
        if (step.channel === 'linkedin' && !templateValues(facts).fullName) {
          this.stopEnrollment(e, 'invalid_target', correlationId, 'system', {
            rule: 'linkedin.nameRequired',
          });
          return 'done';
        }
        if (!target) {
          this.stopEnrollment(e, 'invalid_target', correlationId, 'system');
          return 'done';
        }
        if (!this.latestDraft(run.id) && step.mode === 'ai') {
          this.updateRun(run, { current_state: 'GENERATE_DRAFT' });
          return 'next';
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
          // LinkedIn has no subject line.
          const shownSubject = step.channel === 'linkedin' ? null : subject.text || null;
          this.insertDraft(run, e, step.channel, target, shownSubject, body.text, 1, {
            origin: 'template',
          });
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
        this.updateRun(run, {
          current_state: step.channel === 'web_form' ? 'PREPARE_FORM' : 'CHECK_APPROVAL',
        });
        return 'next';
      }
      case 'CHECK_APPROVAL': {
        const draft = this.latestDraft(run.id);
        if (!draft) {
          this.updateRun(run, { current_state: 'PREPARE_CONTENT' });
          return 'next';
        }
        const preparation = step.channel === 'web_form' ? this.d.forms?.latestFor(run.id) : undefined;
        if (
          step.channel === 'web_form' &&
          (!preparation || preparation.message_draft_id !== draft.id || !this.d.forms?.isCurrent(preparation))
        ) {
          // A form is prepared for exactly this draft before anyone approves it (FR-FRM-003).
          this.updateRun(run, { current_state: 'PREPARE_FORM' });
          return 'next';
        }
        const approval = this.currentApproval(run.id);
        if (
          !approval ||
          approval.message_draft_id !== draft.id ||
          approval.content_hash !== this.approvalHash(step.channel, run.id, draft, target ?? '')
        ) {
          if (approval) this.closeApprovals(run.id, 'superseded');
          // A form a person must finish (a field, a consent, a CAPTCHA) is never approved by policy.
          if (
            this.autoApprovable(e, draft) &&
            (!preparation || (preparation.mode === 'auto' && !this.d.forms?.crossSite(preparation)))
          ) {
            this.requestApproval(run, e, draft, correlationId, true);
            this.updateRun(run, { current_state: 'FINAL_PRE_SEND_CHECK' });
            return 'next';
          }
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
        const hash = draft && target ? this.approvalHash(step.channel, run.id, draft, target) : null;
        const draftHash =
          draft && target ? contentHash(step.channel, target, draft.subject, draft.body) : null;
        if (!draft || !approval || approval.status !== 'approved' || approval.content_hash !== hash) {
          // The draft, the recipient or the form changed after approval: ask again (APPROVAL_STALE, ADR 021 §4).
          this.closeApprovals(run.id, 'superseded');
          if (draft && target && draftHash !== draft.content_hash) {
            this.insertDraft(run, e, step.channel, target, draft.subject, draft.body, draft.version + 1, {
              origin: draft.origin,
              factIds: JSON.parse(draft.fact_ids) as string[],
            });
          }
          this.updateRun(run, { current_state: 'CHECK_APPROVAL' });
          return 'next';
        }
        const earlier = this.earlierAttempt(e, run, this.intentKeyFor(e, run, step, target as string));
        if (earlier === 'completed') {
          // An attempt to the previous address was confirmed sent: the step is done.
          this.updateRun(run, { status: 'completed', current_state: 'COMPLETE' });
          this.finishStep(e, correlationId);
          return 'done';
        }
        if (earlier === 'unresolved') throw new PermanentError('earlier_attempt_unresolved');
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
    const target = facts ? this.targetFor(step.channel, facts) : null;
    if (!draft || !facts || !target || !approval) {
      transaction(this.d.db, () => this.updateRun(run, { current_state: 'FINAL_PRE_SEND_CHECK' }));
      return 'next';
    }
    const intent: IntentParts = {
      scopeId: e.id,
      stepPosition: run.step_position,
      channel: step.channel,
      actionType: actionTypeOf(step),
      target,
    };
    const hash = this.approvalHash(step.channel, run.id, draft, target);
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

    // Final pre-send check (ADR 021 §6): in the reserving transaction, and for a browser channel
    // again at the checkpoint. Everything is read again: reconciliation may have awaited, and a
    // reply, a stop, a pause, an edit or a rejection may have arrived meanwhile (audit 3.5, 6.5).
    const finalCheck = (): void => {
      if (this.d.paused?.()) {
        throw new PolicyBlocked({
          kind: 'defer',
          until: new Date(this.d.now().getTime() + 60_000),
          rule: 'app.paused',
        });
      }
      const freshRun = this.run(run.id);
      const freshE = this.enrollment(e.id);
      if (
        !freshRun ||
        freshRun.status !== 'running' ||
        freshRun.current_state !== 'SEND' ||
        !freshE ||
        freshE.status !== 'active' ||
        this.campaignStatus(freshE.campaign_id) !== 'active'
      ) {
        throw new PolicyBlocked({ kind: 'defer', until: this.d.now(), rule: 'run.changed' });
      }
      // The address may have been edited while the inbox was read (audit 4.5): never the old one.
      const freshFacts = this.contact(e.contact_id);
      const freshApproval = this.currentApproval(run.id);
      if (
        !freshFacts ||
        this.targetFor(step.channel, freshFacts) !== target ||
        !freshApproval ||
        freshApproval.status !== 'approved' ||
        freshApproval.content_hash !== hash
      ) {
        throw new PolicyBlocked({ kind: 'defer', until: this.d.now(), rule: 'approval.stale' });
      }
      if (this.earlierAttempt(e, run, intentKey(intent)))
        throw new PermanentError('earlier_attempt_unresolved');
      const verdict = this.policyVerdict(e, run, step, freshFacts, target);
      if (verdict.kind !== 'ok') throw new PolicyBlocked(verdict);
      const pacing = this.d.policy.checkChannel(channel, intentKey(intent));
      if (pacing.kind !== 'ok') throw new PolicyBlocked(pacing);
      // A switched-off adapter sends nothing, here or at the checkpoint (FR-LIN-001, fails closed).
      const off = channel.unavailable?.();
      if (off) {
        throw new PolicyBlocked({
          kind: 'defer',
          until: new Date(this.d.now().getTime() + 60 * 60_000),
          rule: off,
        });
      }
      const limited = channel.checkLimits?.(intent.actionType, intentKey(intent));
      if (limited) throw new PolicyBlocked({ kind: 'defer', until: limited.until, rule: limited.rule });
      const shared = this.companyForm(e, run, step);
      if (shared === 'sent')
        throw new PolicyBlocked({ kind: 'defer', until: this.d.now(), rule: 'company.form.sent' });
      if (shared === 'pending') {
        throw new PolicyBlocked({
          kind: 'defer',
          until: new Date(this.d.now().getTime() + 30 * 60_000),
          rule: 'company.form',
        });
      }
    };
    // One send at a time per channel account (pacing stays exact); other channels go on.
    const lock = `${channel.channel}:${channel.accountId ?? ''}`;
    const before = this.sending.get(lock) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => (release = r));
    const tail = before.then(() => mine);
    this.sending.set(lock, tail);
    await before;
    try {
      return await this.sendLocked(
        run,
        e,
        step,
        ctx,
        channel,
        draft,
        facts,
        target,
        intent,
        hash,
        audit,
        finalCheck,
      );
    } finally {
      release();
      if (this.sending.get(lock) === tail) this.sending.delete(lock);
    }
  }

  private readonly sending = new Map<string, Promise<void>>();

  private async sendLocked(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    ctx: JobContext,
    channel: MessageChannel,
    draft: DraftRow,
    facts: ContactFacts,
    target: string,
    intent: IntentParts,
    hash: string,
    audit: (status: 'planned' | 'completed' | 'failed' | 'unknown', extra?: Record<string, unknown>) => void,
    finalCheck: () => void,
  ): Promise<'next' | 'done' | { continueAt: Date }> {
    await this.d.beforeSend?.(channel, ctx.signal, run.correlation_id);
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
        onSendError: (error) =>
          this.d.logger.warn(
            { event: 'send.threw', runId: run.id, channel: step.channel, error: String(error) },
            'send threw; outcome unknown',
          ),
        onReconciled: (settled) =>
          audit(settled === 'completed' ? 'completed' : 'failed', {
            reconciled: true,
            ...(settled === 'not_sent' ? { errorClass: 'reconciled_not_sent' } : {}),
          }),
        recheck: () => finalCheck(),
        guard: () => {
          finalCheck();
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
        if (v.rule === 'run.changed') return 'next'; // the next pass sees the stop, pause or cancel
        if (v.rule === 'company.form.sent') {
          this.companyFormDone(fresh, freshEnrollment);
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
    if (outcome.outcome === 'not_sent' && (step.channel === 'web_form' || step.channel === 'linkedin')) {
      const handled =
        step.channel === 'linkedin'
          ? this.linkedinNotSent(run, e, step, outcome.errorClass)
          : this.formNotSent(run, outcome.errorClass);
      if (handled) {
        // Nothing was sent; the attempt is recorded all the same (CLAUDE.md §3.5).
        const notSent = outcome;
        transaction(this.d.db, () => {
          this.recordSendAttempt(run.id, ctx.attempt, notSent);
          audit('failed', { errorClass: notSent.errorClass });
        });
        this.d.changed(['activity']);
        return handled;
      }
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
      const effect = this.d.ledger.get(outcome.sideEffectId);
      this.d.onSent?.({
        channel: step.channel,
        accountId: channel.accountId,
        enrollmentId: e.id,
        contactId: e.contact_id,
        companyId: facts.company_id,
        idempotencyKey: intentKey(intent),
        subject: draft.subject,
        body: draft.body,
        externalRefs: effect ? (JSON.parse(effect.external_refs) as Record<string, unknown>) : {},
      });
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

  /**
   * `auto`: approved by the campaign's policy (approve_campaign, every check passed); otherwise it
   * waits for a person.
   */
  requestApproval(
    run: RunRow,
    e: EnrollmentRow,
    draft: DraftRow,
    correlationId: string,
    auto = false,
  ): string {
    const id = uuidv7();
    const facts = this.contact(e.contact_id);
    const target = (facts && this.targetFor(draft.channel, facts)) ?? '';
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO approvals (id, workflow_run_id, campaign_enrollment_id, message_draft_id, draft_version,
                                target_snapshot, content_hash, scope, status, decided_by, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        run.id,
        e.id,
        draft.id,
        draft.version,
        JSON.stringify({ channel: draft.channel, target, contactId: e.contact_id }),
        this.approvalHash(draft.channel, run.id, draft, target),
        auto ? 'campaign' : 'single_action',
        auto ? 'approved' : 'pending',
        auto ? 'campaign_policy' : null,
        auto ? ts : null,
        ts,
      );
    this.d.audit.record({
      actorType: 'system',
      actionType: auto ? 'approval.auto_approved' : 'approval.requested',
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
    meta: DraftMeta,
  ): DraftRow {
    const id = uuidv7();
    this.d.db
      .prepare(
        `INSERT INTO message_drafts (id, contact_id, company_id, campaign_enrollment_id, workflow_run_id, channel,
                                     subject, body, fact_ids, generation_meta, content_hash, version, origin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(meta.factIds ?? []),
        JSON.stringify(meta.generation ?? {}),
        contentHash(channel, target, subject, body),
        version,
        meta.origin,
        this.d.now().toISOString(),
      );
    const draft = this.d.db
      .prepare('SELECT * FROM message_drafts WHERE id = ?')
      .get(id) as unknown as DraftRow;
    this.storeChecks(draft, e, run, target);
    return draft;
  }

  /** The draft checks for one version (docs/17, ADR 025); kept with it, shown in the approval. */
  private storeChecks(draft: DraftRow, e: EnrollmentRow, run: RunRow, target: string): void {
    const step = this.step(e.campaign_version_id, run.step_position);
    const facts = this.contact(e.contact_id);
    if (!step || step.type !== 'send_message' || !facts) return;
    const config = this.versionConfig(e.campaign_version_id);
    const values = templateValues(facts);
    const signature = renderTemplate(step.signature, values).text.trim();
    const used = this.factsById(JSON.parse(draft.fact_ids) as string[]);
    const checks = runDraftChecks({
      origin: draft.origin,
      subject: draft.subject,
      body: draft.body,
      signature,
      target,
      currentTarget: facts.email_normalized,
      maxLength: config.maxLength,
      forbiddenPhrases: config.forbiddenPhrases,
      allowedLinkDomains: config.allowedLinkDomains,
      sources: [
        ...Object.values(values).filter((v): v is string => Boolean(v)),
        facts.email_normalized ?? '',
        facts.company_domain ?? '',
        step.instructions,
        step.subject,
        step.body,
        signature,
        // Verified text only: the quotes and the pages they were found on — never the model's own
        // wording of a claim (audit 4.5).
        ...used.map((f) => f.quote),
        ...this.evidenceTexts(used.map((f) => f.id)),
        ...this.previousMessages(e, run.step_position).flatMap((m) => [m.subject ?? '', m.body]),
      ],
    });
    const insert = this.d.db.prepare(
      `INSERT INTO draft_checks (message_draft_id, check_key, passed, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const ts = this.d.now().toISOString();
    for (const c of checks) insert.run(draft.id, c.key, c.passed ? 1 : 0, c.detail, ts);
  }

  /**
   * approve_campaign (docs/17): once the user approved `sampleSize` messages of this campaign
   * version by hand, a draft that passes every check is approved by the campaign's policy. Edited
   * drafts always go to the user.
   */
  private autoApprovable(e: EnrollmentRow, draft: DraftRow): boolean {
    const config = this.versionConfig(e.campaign_version_id);
    if (config.approvalMode !== 'approve_campaign' || draft.origin === 'user') return false;
    const checks = this.d.db
      .prepare('SELECT check_key AS key, passed, detail FROM draft_checks WHERE message_draft_id = ?')
      .all(draft.id) as { key: string; passed: number; detail: string | null }[];
    if (!allPassed(checks.map((c) => ({ key: c.key as 'length', passed: c.passed === 1, detail: c.detail }))))
      return false;
    // The sample is of the same kind of message: this version, this step, this origin — approving
    // template messages says nothing about what AI writes (audit 4.5).
    const { n } = this.d.db
      .prepare(
        `SELECT COUNT(*) AS n FROM approvals a
         JOIN campaign_enrollments ce ON ce.id = a.campaign_enrollment_id
         JOIN workflow_runs r ON r.id = a.workflow_run_id
         JOIN message_drafts d ON d.id = a.message_draft_id
         WHERE ce.campaign_version_id = ? AND r.step_position = (SELECT step_position FROM workflow_runs WHERE id = ?)
           AND d.origin = ? AND a.status = 'approved' AND a.decided_by = 'user'`,
      )
      .get(e.campaign_version_id, draft.workflow_run_id, draft.origin) as { n: number };
    return n >= config.sampleSize;
  }

  /** Verified research facts by id, for checks and approvals. */
  factsById(ids: string[]): { id: string; claim: string; quote: string; url: string | null }[] {
    if (ids.length === 0) return [];
    return this.d.db
      .prepare(
        `SELECT f.id, f.claim, f.quote, ev.url FROM research_facts f LEFT JOIN evidence ev ON ev.id = f.evidence_id
         WHERE f.id IN (${ids.map(() => '?').join(', ')}) AND f.verified = 1 AND f.quote IS NOT NULL`,
      )
      .all(...ids) as { id: string; claim: string; quote: string; url: string | null }[];
  }

  /** The captured text of the pages the given facts were verified on. */
  private evidenceTexts(factIds: string[]): string[] {
    if (factIds.length === 0) return [];
    return (
      this.d.db
        .prepare(
          `SELECT DISTINCT ev.text FROM research_facts f JOIN evidence ev ON ev.id = f.evidence_id
           WHERE f.id IN (${factIds.map(() => '?').join(', ')}) AND f.verified = 1`,
        )
        .all(...factIds) as { text: string }[]
    ).map((r) => r.text);
  }

  /** What was actually sent to this contact in earlier steps of the enrollment. */
  private previousMessages(e: EnrollmentRow, beforeStep: number): { subject: string | null; body: string }[] {
    return this.d.db
      .prepare(
        `SELECT d.subject, d.body FROM side_effects se
         JOIN message_drafts d ON d.workflow_run_id = se.workflow_run_id AND d.content_hash = se.content_hash
         WHERE se.scope_id = ? AND se.status = 'completed' AND se.step_position < ?
         GROUP BY se.id ORDER BY se.step_position`,
      )
      .all(e.id, beforeStep) as { subject: string | null; body: string }[];
  }

  /**
   * GENERATE_DRAFT: research and the model are awaited outside any transaction; the result is
   * stored only if the run is still where it was (a stop or pause meanwhile wins).
   */
  /**
   * Who a step writes to: the contact's email, or for a website form the company's site (its
   * origin). null: the step cannot reach this contact.
   */
  targetFor(channel: string, facts: ContactFacts): string | null {
    if (channel === 'web_form') return websiteTarget(facts.company_website ?? facts.company_domain);
    if (channel === 'linkedin') return facts.linkedin_url ? `https://www.${facts.linkedin_url}/` : null;
    return facts.email_normalized;
  }

  /**
   * What an approval covers: the message to the current recipient, and for a form exactly the
   * prepared form (Phase 6). Anything different asks for approval again.
   */
  approvalHash(channel: string, runId: string, draft: DraftRow, target: string): string {
    const base = contentHash(channel, target, draft.subject, draft.body);
    if (channel !== 'web_form') return base;
    const preparation = this.d.forms?.latestFor(runId);
    if (!preparation || preparation.message_draft_id !== draft.id || !this.d.forms)
      return `unprepared:${base}`;
    // Prepared for other sender settings: never matches, so it is prepared and approved again.
    if (!this.d.forms.isCurrent(preparation)) return `stale-sender:${base}`;
    return this.d.forms.approvalHash(base, preparation);
  }

  /** PREPARE_FORM: find, map, fill and photograph the company's form for the latest draft. */
  private async prepareForm(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    ctx: JobContext,
  ): Promise<'next' | 'done' | { continueAt: Date }> {
    const later = (ms: number) => ({ continueAt: new Date(this.d.now().getTime() + ms) });
    // Opening a site is browser work: none starts while the app is paused (docs/19).
    if (this.d.paused?.()) return later(60_000);
    const shared = this.companyForm(e, run, step);
    if (shared === 'pending') return later(30 * 60_000);
    if (shared === 'sent') {
      transaction(this.d.db, () => this.companyFormDone(run, e));
      return 'done';
    }
    const draft = this.latestDraft(run.id);
    const facts = this.contact(e.contact_id);
    const website = facts ? this.targetFor(step.channel, facts) : null;
    if (!draft || !website || !this.d.forms) {
      transaction(this.d.db, () => this.updateRun(run, { current_state: 'PREPARE_CONTENT' }));
      if (!this.d.forms) throw new PermanentError('channel_unavailable');
      return 'next';
    }
    let prepared: PrepareOutcome;
    try {
      prepared = await this.d.forms.prepare({
        workflowRunId: run.id,
        draftId: draft.id,
        website,
        subject: draft.subject,
        body: draft.body,
        // A form step is never `manual` (refused at launch); were it, the person presses.
        stepMode: step.executionMode === 'manual' ? 'assisted' : step.executionMode,
        // A form prepared three times already keeps changing (audit 6.5): the person sends it.
        forceAssisted: this.preparationCount(run.id) >= 3,
        signal: ctx.signal,
        correlationId: run.correlation_id,
      });
    } catch (error) {
      this.d.logger.warn({ event: 'form.prepare_failed', runId: run.id, err: error }, 'form not prepared');
      throw new RetryableError('form_prepare_failed');
    }
    if (prepared.kind === 'no_sender') throw new PermanentError('channel_unavailable');
    // The person holds the sender's window: preparing waits for it, without using up attempts.
    if (prepared.kind === 'busy') return later(120_000);
    return transaction(this.d.db, () => {
      const fresh = this.run(run.id);
      if (!fresh || fresh.current_state !== 'PREPARE_FORM' || TERMINAL.has(fresh.status)) return 'done';
      if (prepared.kind === 'no_form') {
        this.stopEnrollment(e, 'no_contact_form', run.correlation_id, 'system', { website });
        return 'done';
      }
      this.d.audit.record({
        actorType: 'browser_worker',
        actionType: 'form.prepared',
        objectType: 'enrollment',
        objectId: e.id,
        payload: {
          runId: run.id,
          status: prepared.preparation.status,
          mode: prepared.preparation.mode,
          pack: `web-form@${prepared.preparation.pack_version}`,
        },
        correlationId: run.correlation_id,
      });
      this.updateRun(fresh, { current_state: 'CHECK_APPROVAL' });
      this.d.changed(['enrollment', 'activity']);
      return 'next';
    });
  }

  /**
   * A LinkedIn action that did not happen, and what it means (Phase 7). Nothing was pressed:
   * - the person answered (FR-LIN-004): the enrollment stops as replied, and the reply is recorded;
   *   before the campaign has done anything on LinkedIn, their message is no answer to it: the
   *   enrollment stops as `unanswered_message`, for the person to answer it themselves;
   * - an invitation to someone already invited or connected: the step is done without sending;
   * - a message to someone not connected yet: it waits a day, up to two weeks (`not_connected`);
   * - a page about someone else: the target is wrong, the enrollment stops;
   * - signed out, a security check, the person's window, a thread that could not be read: it waits.
   */
  private linkedinNotSent(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    errorClass: string,
  ): 'next' | 'done' | { continueAt: Date } | null {
    const later = (ms: number) => ({ continueAt: new Date(this.d.now().getTime() + ms) });
    return transaction(this.d.db, () => {
      const fresh = this.run(run.id);
      const freshE = this.enrollment(e.id);
      if (!fresh || TERMINAL.has(fresh.status) || !freshE) return null;
      if (errorClass === 'linkedin.replied') {
        if (!this.actedOnLinkedin(e, run.step_position)) {
          this.stopEnrollment(freshE, 'unanswered_message', run.correlation_id, 'system', {
            channel: 'linkedin',
          });
          return 'done';
        }
        this.d.audit.record({
          actorType: 'browser_worker',
          actionType: 'linkedin.reply_detected',
          objectType: 'enrollment',
          objectId: e.id,
          payload: { runId: run.id, step: run.step_position },
          correlationId: run.correlation_id,
        });
        this.stopEnrollment(freshE, 'replied', run.correlation_id, 'system', { channel: 'linkedin' });
        return 'done';
      }
      const connected = ['state:linkedin.profile.pending', 'state:linkedin.profile.messageable'];
      if (step.linkedinAction === 'connect' && connected.includes(errorClass)) {
        this.d.audit.record({
          actorType: 'browser_worker',
          actionType: 'linkedin.already_connected',
          objectType: 'enrollment',
          objectId: e.id,
          payload: { runId: run.id, state: errorClass.slice('state:'.length) },
          correlationId: run.correlation_id,
        });
        this.updateRun(fresh, { status: 'completed', current_state: 'COMPLETE' });
        this.finishStep(freshE, run.correlation_id);
        return 'done';
      }
      if (
        step.linkedinAction === 'message' &&
        ['state:linkedin.profile.connectable', 'state:linkedin.profile.pending'].includes(errorClass)
      ) {
        const waited = this.d.now().getTime() - new Date(this.runCreatedAt(run.id)).getTime();
        if (waited > 14 * 24 * 60 * 60_000) {
          this.stopEnrollment(freshE, 'not_connected', run.correlation_id, 'system');
          return 'done';
        }
        return later(24 * 60 * 60_000);
      }
      if (errorClass === 'task.identityMismatch') {
        this.stopEnrollment(freshE, 'invalid_target', run.correlation_id, 'system', { rule: errorClass });
        return 'done';
      }
      if (errorClass === 'task.checkpointRefused') return 'next';
      if (
        ['task.loginRequired', 'needs_human', 'linkedin.threadUnread', 'task.identityRequired'].includes(
          errorClass,
        )
      ) {
        return later(60 * 60_000);
      }
      if (
        ['profile.inUseByYou', 'user_control', 'session.busy', 'profile.alreadyOpen'].includes(errorClass)
      ) {
        return later(120_000);
      }
      return null;
    });
  }

  /** Whether an earlier step of the enrollment invited or wrote to the person on LinkedIn. */
  private actedOnLinkedin(e: EnrollmentRow, beforeStep: number): boolean {
    return (
      this.d.db
        .prepare(
          `SELECT 1 FROM side_effects WHERE scope_id = ? AND channel = 'linkedin'
             AND status = 'completed' AND step_position < ? LIMIT 1`,
        )
        .get(e.id, beforeStep) !== undefined
    );
  }

  private runCreatedAt(runId: string): string {
    return (
      this.d.db.prepare('SELECT created_at FROM workflow_runs WHERE id = ?').get(runId) as {
        created_at: string;
      }
    ).created_at;
  }

  /**
   * A form send that did not happen, and what it means (Phase 6): a changed form is prepared and
   * approved again; a CAPTCHA that appeared makes the person press Send (approved again, in
   * assisted mode); a window the person holds makes the send wait. Nothing was sent in any case.
   */
  private formNotSent(run: RunRow, errorClass: string): 'next' | { continueAt: Date } | null {
    return transaction(this.d.db, () => {
      const fresh = this.run(run.id);
      if (!fresh || TERMINAL.has(fresh.status)) return null;
      if (errorClass === 'form.changed') {
        this.closeApprovals(run.id, 'superseded');
        this.updateRun(fresh, { current_state: 'PREPARE_FORM' });
        return 'next';
      }
      if (errorClass === 'needs_human' || errorClass === 'form.invalid') {
        const preparation = this.d.forms?.latestFor(run.id);
        if (preparation && preparation.mode === 'auto') {
          this.d.forms?.requireAssisted(preparation.id);
          this.updateRun(fresh, { current_state: 'FINAL_PRE_SEND_CHECK' });
          return 'next';
        }
      }
      // Refused at the checkpoint (a stop, pause, reply or edit arrived while the form was filled):
      // the next pass runs the final checks again and acts on what changed; no attempt is used.
      if (errorClass === 'task.checkpointRefused') return 'next';
      if (
        ['profile.inUseByYou', 'user_control', 'session.busy', 'profile.alreadyOpen'].includes(errorClass)
      ) {
        return { continueAt: new Date(this.d.now().getTime() + 120_000) };
      }
      return null;
    });
  }

  /**
   * The form sender changed: forms waiting for approval were prepared with the old details, so
   * they are prepared again (with the new ones) and a new approval follows (audit 6.5).
   */
  reprepareForms(correlationId: string): number {
    const runs = this.d.db
      .prepare(
        `SELECT r.* FROM workflow_runs r
         WHERE r.workflow_type = 'campaign_message' AND r.status = 'waiting_approval'
           AND EXISTS (SELECT 1 FROM form_preparations p WHERE p.workflow_run_id = r.id)`,
      )
      .all() as unknown as RunRow[];
    transaction(this.d.db, () => {
      for (const run of runs) {
        this.closeApprovals(run.id, 'superseded');
        this.updateRun(run, { status: 'running', current_state: 'PREPARE_FORM' });
        this.wakeRun(run.id, correlationId);
      }
    });
    if (runs.length > 0) this.d.changed(['approval', 'enrollment']);
    return runs.length;
  }

  private preparationCount(runId: string): number {
    return (
      this.d.db
        .prepare('SELECT COUNT(*) AS n FROM form_preparations WHERE workflow_run_id = ?')
        .get(runId) as {
        n: number;
      }
    ).n;
  }

  /**
   * A company's contact form is written to once per campaign step, however many of its people are
   * enrolled (audit 6.5): `sent` when another enrollment's form send completed, `pending` while one
   * may be under way or is unresolved.
   */
  private companyForm(e: EnrollmentRow, run: RunRow, step: SendStep): 'sent' | 'pending' | null {
    if (step.channel !== 'web_form') return null;
    const facts = this.contact(e.contact_id);
    const target = facts ? this.targetFor(step.channel, facts) : null;
    if (!target) return null;
    const rows = this.d.db
      .prepare(
        `SELECT se.status FROM side_effects se JOIN campaign_enrollments o ON o.id = se.scope_id
         WHERE se.channel = 'web_form' AND se.target_normalized = ? AND se.step_position = ?
           AND o.campaign_id = ? AND se.scope_id != ?
           AND se.status IN ('reserved', 'executing', 'completed', 'unknown')`,
      )
      .all(target, run.step_position, e.campaign_id, e.id) as { status: string }[];
    if (rows.some((r) => r.status === 'completed')) return 'sent';
    return rows.length > 0 ? 'pending' : null;
  }

  /** The company's form already went out for this step: this contact's step is done, nothing sent. */
  private companyFormDone(run: RunRow, e: EnrollmentRow): void {
    const fresh = this.run(run.id);
    if (!fresh || TERMINAL.has(fresh.status)) return;
    this.closeApprovals(run.id, 'superseded');
    this.updateRun(fresh, { status: 'completed', current_state: 'COMPLETE' });
    this.d.audit.record({
      actorType: 'system',
      actionType: 'form.already_sent',
      objectType: 'enrollment',
      objectId: e.id,
      payload: { runId: run.id, step: run.step_position },
      correlationId: run.correlation_id,
    });
    const freshE = this.enrollment(e.id);
    if (freshE?.status === 'active' || freshE?.status === 'paused')
      this.finishStep(freshE, run.correlation_id);
    this.d.changed(['enrollment', 'activity']);
  }

  private async generate(
    run: RunRow,
    e: EnrollmentRow,
    step: SendStep,
    ctx: JobContext,
  ): Promise<'next' | 'done' | { continueAt: Date }> {
    const facts = this.contact(e.contact_id);
    const target = facts ? this.targetFor(step.channel, facts) : null;
    if (!facts || !target) {
      transaction(this.d.db, () => this.stopEnrollment(e, 'invalid_target', run.correlation_id, 'system'));
      return 'done';
    }
    const values = templateValues(facts);
    const signature = renderTemplate(step.signature, values);
    if (signature.missing.length > 0) {
      transaction(this.d.db, () =>
        this.stopEnrollment(e, 'missing_data', run.correlation_id, 'system', { fields: signature.missing }),
      );
      return 'done';
    }
    const config = this.versionConfig(e.campaign_version_id);
    const result: DraftResult = this.d.drafter
      ? await this.d.drafter.write(
          {
            companyId: facts.company_id,
            instructions: step.instructions,
            stepNumber: run.step_position,
            // A LinkedIn invitation note holds 300 characters at most.
            maxLength: Math.max(
              100,
              (step.channel === 'linkedin' && step.linkedinAction === 'connect' ? 300 : config.maxLength) -
                signature.text.length -
                2,
            ),
            recipient: {
              firstName: facts.first_name,
              lastName: facts.last_name,
              jobTitle: facts.job_title,
              companyName: facts.company_name,
            },
            previous: this.previousMessages(e, run.step_position),
          },
          ctx.signal,
          run.correlation_id,
        )
      : { kind: 'failed', reason: 'no_key' };
    if (result.kind === 'wait') return { continueAt: result.until };
    return transaction(this.d.db, () => {
      const fresh = this.run(run.id);
      if (!fresh || fresh.current_state !== 'GENERATE_DRAFT' || TERMINAL.has(fresh.status)) return 'done';
      if (result.kind === 'failed') {
        this.stopEnrollment(e, 'draft_failed', run.correlation_id, 'system', { reason: result.reason });
        return 'done';
      }
      const sig = signature.text.trim();
      const text = cleanDraftBody(result.draft.body, sig);
      const body = sig ? `${text}\n\n${sig}` : text;
      const draft = this.insertDraft(
        run,
        e,
        step.channel,
        target,
        step.channel === 'linkedin' ? null : cleanSubject(result.draft.subject),
        body,
        1,
        {
          origin: 'ai',
          factIds: result.facts.map((f) => f.id),
          generation: { template: result.template, model: result.model, researchRunId: result.researchRunId },
        },
      );
      this.d.audit.record({
        actorType: 'ai',
        actionType: 'draft.generated',
        objectType: 'enrollment',
        objectId: e.id,
        payload: { draftId: draft.id, facts: result.facts.length },
        correlationId: run.correlation_id,
      });
      this.updateRun(fresh, { current_state: 'CHECK_POLICY' });
      this.d.changed(['enrollment']);
      return 'next';
    });
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
                co.domain_normalized AS company_domain, co.website_url AS company_website,
                co.timezone AS company_timezone,
                (SELECT url_normalized FROM contact_profile_urls
                 WHERE contact_id = c.id AND channel = 'linkedin' LIMIT 1) AS linkedin_url
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
    let websiteHost: string | null = null;
    if (step.channel === 'web_form' && target) {
      try {
        websiteHost = new URL(target).hostname;
      } catch {
        websiteHost = null;
      }
    }
    return this.d.policy.check({
      channel: step.channel,
      websiteHost,
      contactId: e.contact_id,
      companyId: facts.company_id,
      idempotencyKey: this.intentKeyFor(e, run, step, target ?? ''),
      timeZone: this.timeZoneFor(e, facts),
      window: this.windowFor(e.campaign_version_id),
    });
  }

  /**
   * Another attempt for the same step under a different key — the recipient's address changed
   * after an attempt. `unresolved`: it may have been delivered; a person decides before anything
   * else is sent. `completed`: it was, so the step is done.
   */
  private earlierAttempt(e: EnrollmentRow, run: RunRow, key: string): 'completed' | 'unresolved' | null {
    const others = this.d.ledger.forStep(e.id, run.step_position).filter((se) => se.idempotency_key !== key);
    if (others.some((se) => se.status === 'executing' || se.status === 'unknown')) return 'unresolved';
    if (others.some((se) => se.status === 'completed')) return 'completed';
    return null;
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
      actionType: actionTypeOf(step),
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
