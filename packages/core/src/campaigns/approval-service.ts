import type { DatabaseSync } from 'node:sqlite';
import {
  draftCheckKeySchema,
  RpcError,
  type Approval,
  type DraftCheck,
  type DraftVersion,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { SideEffectLedger } from '../ledger/side-effects.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { ApprovalRow, CampaignEngine, DraftRow } from './engine.js';

const CHECK_ORDER = draftCheckKeySchema.options;
const stale = () => new RpcError('APPROVAL_STALE', 'The draft changed', 'approval.stale');
const conflict = (detail: string) => new RpcError('CONFLICT', 'Not possible in the current state', detail);

/**
 * The approval queue (FR-APR-001…005, ADR 021 §4). Decisions only record what the user decided
 * and wake the workflow run; the run's state machine makes every transition.
 */
export class ApprovalService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly engine: CampaignEngine,
    private readonly ledger: SideEffectLedger,
    private readonly now: () => Date,
  ) {}

  pending(campaignId?: string): Approval[] {
    const rows = this.db
      .prepare(
        `SELECT a.id FROM approvals a JOIN campaign_enrollments e ON e.id = a.campaign_enrollment_id
         WHERE a.status = 'pending' ${campaignId ? 'AND e.campaign_id = ?' : ''}
         ORDER BY a.created_at, a.id LIMIT 500`,
      )
      .all(...(campaignId ? [campaignId] : [])) as { id: string }[];
    return rows.map((r) => this.dto(r.id));
  }

  approve(approvalId: string, contentHash: string, ctx: CommandContext): void {
    this.decide(approvalId, 'approved', ctx, (approval, draft) => {
      // The user approved what they saw; it must still be what would be sent.
      if (contentHash !== approval.content_hash || draft.content_hash !== approval.content_hash)
        throw stale();
    });
  }

  reject(approvalId: string, ctx: CommandContext): void {
    this.decide(approvalId, 'rejected', ctx);
  }

  /** Do not send this message; the enrollment moves on to its next step. */
  skip(approvalId: string, ctx: CommandContext): void {
    this.decide(approvalId, 'skipped', ctx);
  }

  /**
   * Edits the message: a new draft version; open approvals are superseded and a new pending one is
   * created. Refused once the send may have happened — an edit must never cause a second message.
   */
  revise(draftId: string, subject: string, body: string, ctx: CommandContext): Approval {
    return transaction(this.db, () => {
      const draft = this.db.prepare('SELECT * FROM message_drafts WHERE id = ?').get(draftId) as
        DraftRow | undefined;
      if (!draft) throw new RpcError('NOT_FOUND', 'Draft not found', 'draft.notFound');
      const latest = this.engine.latestDraft(draft.workflow_run_id);
      if (latest?.id !== draft.id) throw stale();
      const run = this.engine.run(draft.workflow_run_id);
      const e = this.engine.enrollment(draft.campaign_enrollment_id);
      if (!run || !e || ['completed', 'failed', 'cancelled'].includes(run.status))
        throw conflict('draft.closed');
      const started = this.ledger
        .forStep(e.id, run.step_position)
        .some((se) => se.status === 'executing' || se.status === 'completed' || se.status === 'unknown');
      if (started) throw conflict('draft.alreadySent');
      const target = this.engine.contact(e.contact_id)?.email_normalized;
      if (!target) throw conflict('draft.noTarget');
      const next = this.engine.insertDraft(
        run,
        e,
        draft.channel,
        target,
        subject.trim() || null,
        body,
        draft.version + 1,
        // A person's edit: the facts stay attached, but it always needs a person's approval.
        { origin: 'user', factIds: JSON.parse(draft.fact_ids) as string[] },
      );
      this.engine.closeApprovals(run.id, 'superseded');
      const approvalId = this.engine.requestApproval(run, e, next, ctx.correlationId);
      this.engine.updateRun(run, {
        current_state: 'CHECK_APPROVAL',
        ...(run.status === 'paused' ? {} : { status: 'waiting_approval' as const }),
      });
      this.audit.record({
        actorType: 'user',
        actionType: 'draft.revised',
        objectType: 'enrollment',
        objectId: e.id,
        payload: { draftId: next.id, version: next.version },
        correlationId: ctx.correlationId,
      });
      return this.dto(approvalId);
    });
  }

  /** Every version of the message a draft belongs to, newest first (FR-APR "revision history"). */
  history(draftId: string): DraftVersion[] {
    const draft = this.db.prepare('SELECT workflow_run_id FROM message_drafts WHERE id = ?').get(draftId) as
      { workflow_run_id: string } | undefined;
    if (!draft) throw new RpcError('NOT_FOUND', 'Draft not found', 'draft.notFound');
    const rows = this.db
      .prepare(
        `SELECT id, version, origin, subject, body, created_at FROM message_drafts
         WHERE workflow_run_id = ? ORDER BY version DESC`,
      )
      .all(draft.workflow_run_id) as {
      id: string;
      version: number;
      origin: DraftVersion['origin'];
      subject: string | null;
      body: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      origin: r.origin,
      subject: r.subject,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  private decide(
    approvalId: string,
    status: 'approved' | 'rejected' | 'skipped',
    ctx: CommandContext,
    check?: (approval: ApprovalRow, draft: DraftRow) => void,
  ): void {
    transaction(this.db, () => {
      const approval = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
        ApprovalRow | undefined;
      if (!approval) throw new RpcError('NOT_FOUND', 'Approval not found', 'approval.notFound');
      if (approval.status !== 'pending') throw conflict('approval.notPending');
      const draft = this.engine.latestDraft(approval.workflow_run_id);
      if (!draft || draft.id !== approval.message_draft_id) throw stale();
      check?.(approval, draft);
      this.db
        .prepare(`UPDATE approvals SET status = ?, decided_by = 'user', decided_at = ? WHERE id = ?`)
        .run(status, this.now().toISOString(), approvalId);
      this.audit.record({
        actorType: 'user',
        actionType: `approval.${status}`,
        objectType: 'approval',
        objectId: approvalId,
        payload: { enrollmentId: approval.campaign_enrollment_id, draftVersion: approval.draft_version },
        correlationId: ctx.correlationId,
      });
      const run = this.engine.run(approval.workflow_run_id);
      if (run?.status === 'waiting_approval') {
        this.engine.updateRun(run, { status: 'running' });
        this.engine.wakeRun(run.id, run.correlation_id);
      }
    });
  }

  private dto(approvalId: string): Approval {
    const r = this.db
      .prepare(
        `SELECT a.*, e.campaign_id, e.contact_id, cam.name AS campaign_name, r.step_position,
                d.subject, d.body, d.channel, d.version AS draft_version_number, d.origin, d.fact_ids,
                c.first_name, c.last_name, c.full_name, c.email
         FROM approvals a
         JOIN campaign_enrollments e ON e.id = a.campaign_enrollment_id
         JOIN campaigns cam ON cam.id = e.campaign_id
         JOIN workflow_runs r ON r.id = a.workflow_run_id
         JOIN message_drafts d ON d.id = a.message_draft_id
         JOIN contacts c ON c.id = e.contact_id
         WHERE a.id = ?`,
      )
      .get(approvalId) as unknown as ApprovalRow & {
      campaign_id: string;
      contact_id: string;
      campaign_name: string;
      step_position: number;
      subject: string | null;
      body: string;
      channel: string;
      draft_version_number: number;
      origin: Approval['origin'];
      fact_ids: string;
      first_name: string | null;
      last_name: string | null;
      full_name: string | null;
      email: string | null;
    };
    const target = (JSON.parse(r.target_snapshot) as { target?: string }).target ?? '';
    return {
      id: r.id,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      enrollmentId: r.campaign_enrollment_id,
      contactId: r.contact_id,
      contactName:
        r.full_name ?? ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || target),
      target,
      channel: r.channel,
      stepPosition: r.step_position,
      draftId: r.message_draft_id,
      draftVersion: r.draft_version_number,
      subject: r.subject,
      body: r.body,
      contentHash: r.content_hash,
      origin: r.origin,
      checks: (
        this.db
          .prepare('SELECT check_key, passed, detail FROM draft_checks WHERE message_draft_id = ?')
          .all(r.message_draft_id) as {
          check_key: DraftCheck['key'];
          passed: number;
          detail: string | null;
        }[]
      )
        .map((c) => ({ key: c.check_key, passed: c.passed === 1, detail: c.detail }))
        .sort((a, b) => CHECK_ORDER.indexOf(a.key) - CHECK_ORDER.indexOf(b.key)),
      facts: this.engine.factsById(JSON.parse(r.fact_ids) as string[]),
      createdAt: r.created_at,
    };
  }
}
