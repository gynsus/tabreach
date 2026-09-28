import type { DatabaseSync } from 'node:sqlite';
import {
  campaignConfigSchema,
  EMPTY_CAMPAIGN_CONFIG,
  RpcError,
  uuidv7,
  type Campaign,
  type CampaignConfig,
  type CampaignStatus,
  type Enrollment,
  type EnrollmentStatus,
  type EnrollReport,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import type { MessageChannel } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import type { JobQueue } from '../jobs/queue.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import { JOB_RUN, type CampaignEngine, type EnrollmentRow, type VersionConfig } from './engine.js';
import { isValidTimeZone } from './schedule.js';
import { unknownPlaceholders } from './template.js';

interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  draft_config: string;
  active_version_id: string | null;
  created_at: string;
  updated_at: string;
  lock_version: number;
}

const notFound = (what: string) => new RpcError('NOT_FOUND', `${what} not found`, `${what}.notFound`);
const conflict = (detail: string) => new RpcError('CONFLICT', 'Not possible in the current state', detail);

/** Campaign lifecycle, launch validation and enrollment management (docs/17). */
export class CampaignService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly engine: CampaignEngine,
    private readonly jobs: JobQueue,
    private readonly channels: ReadonlyMap<string, MessageChannel>,
    private readonly now: () => Date,
  ) {}

  list(includeArchived: boolean): Campaign[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM campaigns ${includeArchived ? '' : "WHERE status != 'archived'"} ORDER BY created_at DESC`,
      )
      .all() as unknown as CampaignRow[];
    return rows.map((r) => this.toDto(r));
  }

  get(id: string): Campaign {
    return this.toDto(this.row(id));
  }

  create(input: { name: string; config?: CampaignConfig | undefined }, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const id = uuidv7();
      const ts = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO campaigns (id, name, status, draft_config, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?)`,
        )
        .run(id, input.name, JSON.stringify(input.config ?? EMPTY_CAMPAIGN_CONFIG), ts, ts);
      this.record('campaign.created', id, ctx);
      return this.get(id);
    });
  }

  update(
    input: { id: string; name?: string | undefined; config?: CampaignConfig | undefined },
    ctx: CommandContext,
  ): Campaign {
    return transaction(this.db, () => {
      const row = this.row(input.id);
      if (row.status === 'archived') throw conflict('campaign.archived');
      this.save(row, {
        name: input.name ?? row.name,
        draft_config: input.config ? JSON.stringify(input.config) : row.draft_config,
      });
      this.record('campaign.updated', row.id, ctx, {
        fields: [input.name !== undefined && 'name', input.config !== undefined && 'config'].filter(Boolean),
      });
      return this.get(row.id);
    });
  }

  /**
   * Freezes the draft as a new immutable version and activates the campaign. Enrollments already
   * running stay on the version they started with (docs/17).
   */
  launch(id: string, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (row.status === 'archived') throw conflict('campaign.archived');
      const config = campaignConfigSchema.parse(JSON.parse(row.draft_config));
      this.validate(config);
      const versionId = uuidv7();
      const number =
        ((
          this.db
            .prepare('SELECT MAX(version_number) AS n FROM campaign_versions WHERE campaign_id = ?')
            .get(id) as {
            n: number | null;
          }
        ).n ?? 0) + 1;
      const ts = this.now().toISOString();
      const { steps, ...settings } = config;
      const frozen: VersionConfig = settings;
      this.db
        .prepare(
          'INSERT INTO campaign_versions (id, campaign_id, version_number, config, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(versionId, id, number, JSON.stringify(frozen), ts);
      const insertStep = this.db.prepare(
        `INSERT INTO sequence_steps (id, campaign_version_id, position, step_type, execution_mode, delay_seconds, config, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      steps.forEach((step, i) =>
        insertStep.run(
          uuidv7(),
          versionId,
          i + 1,
          step.type,
          step.type === 'send_message' ? step.executionMode : null,
          step.delaySeconds,
          JSON.stringify(step),
          ts,
        ),
      );
      this.save(row, { status: 'active', active_version_id: versionId });
      this.record('campaign.launched', id, ctx, { version: number, steps: steps.length });
      this.engine.resync({ campaignId: id });
      return this.get(id);
    });
  }

  pause(id: string, ctx: CommandContext): Campaign {
    return this.setStatus(id, 'paused', ['active'], 'campaign.paused', ctx);
  }

  resume(id: string, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const campaign = this.setStatus(id, 'active', ['paused'], 'campaign.resumed', ctx);
      this.engine.resync({ campaignId: id });
      return campaign;
    });
  }

  /** Archiving stops every live enrollment; sent messages are of course not undone. */
  archive(id: string, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const campaign = this.setStatus(
        id,
        'archived',
        ['draft', 'active', 'paused'],
        'campaign.archived',
        ctx,
      );
      const live = this.db
        .prepare(
          `SELECT * FROM campaign_enrollments WHERE campaign_id = ? AND status IN ('active', 'paused')`,
        )
        .all(id) as unknown as EnrollmentRow[];
      for (const e of live) this.engine.stopEnrollment(e, 'campaign_archived', ctx.correlationId, 'user');
      return campaign;
    });
  }

  enroll(campaignId: string, contactIds: readonly string[], ctx: CommandContext): EnrollReport {
    return transaction(this.db, () => {
      const row = this.row(campaignId);
      if (!row.active_version_id || (row.status !== 'active' && row.status !== 'paused')) {
        throw conflict('campaign.notLaunched');
      }
      const versionId = row.active_version_id;
      const report: EnrollReport = { enrolled: 0, alreadyEnrolled: 0, skipped: 0 };
      const existing = this.db.prepare(
        'SELECT 1 FROM campaign_enrollments WHERE campaign_id = ? AND contact_id = ?',
      );
      const contact = this.db.prepare(`SELECT company_id FROM contacts WHERE id = ? AND status = 'active'`);
      const insert = this.db.prepare(
        `INSERT INTO campaign_enrollments (id, campaign_id, campaign_version_id, company_id, contact_id, status,
                                           current_step_position, next_action_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      );
      const ts = this.now().toISOString();
      for (const contactId of new Set(contactIds)) {
        if (existing.get(campaignId, contactId)) {
          report.alreadyEnrolled++;
          continue;
        }
        const c = contact.get(contactId) as { company_id: string | null } | undefined;
        if (!c) {
          report.skipped++;
          continue;
        }
        const id = uuidv7();
        const at = this.engine.firstActionAt(versionId, contactId);
        insert.run(id, campaignId, versionId, c.company_id, contactId, at.toISOString(), ts, ts);
        if (row.status === 'active') this.engine.scheduleEnrollment(id, at);
        report.enrolled++;
      }
      this.record('campaign.enrolled', campaignId, ctx, { ...report });
      return report;
    });
  }

  listEnrollments(
    campaignId: string,
    page: { limit: number; offset: number },
  ): { items: Enrollment[]; total: number } {
    this.row(campaignId);
    const rows = this.db
      .prepare(
        `SELECT e.*, c.first_name, c.last_name, c.full_name, c.email FROM campaign_enrollments e
         JOIN contacts c ON c.id = e.contact_id
         WHERE e.campaign_id = ? ORDER BY e.created_at, e.id LIMIT ? OFFSET ?`,
      )
      .all(campaignId, page.limit, page.offset) as unknown as (EnrollmentRow & ContactNameRow)[];
    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM campaign_enrollments WHERE campaign_id = ?')
        .get(campaignId) as { n: number }
    ).n;
    return { items: rows.map((r) => this.enrollmentDto(r)), total };
  }

  pauseEnrollment(id: string, ctx: CommandContext): Enrollment {
    return transaction(this.db, () => {
      const e = this.enrollmentRow(id);
      if (e.status !== 'active') throw conflict('enrollment.notActive');
      this.engine.updateEnrollment(e, { status: 'paused' });
      this.record('enrollment.paused', id, ctx, {}, 'enrollment');
      return this.enrollmentById(id);
    });
  }

  resumeEnrollment(id: string, ctx: CommandContext): Enrollment {
    return transaction(this.db, () => {
      const e = this.enrollmentRow(id);
      if (e.status !== 'paused') throw conflict('enrollment.notPaused');
      this.engine.updateEnrollment(e, { status: 'active' });
      this.record('enrollment.resumed', id, ctx, {}, 'enrollment');
      this.engine.resync({ enrollmentId: id });
      return this.enrollmentById(id);
    });
  }

  stopEnrollment(id: string, ctx: CommandContext): Enrollment {
    return transaction(this.db, () => {
      const e = this.enrollmentRow(id);
      if (e.status !== 'active' && e.status !== 'paused') throw conflict('enrollment.finished');
      this.engine.stopEnrollment(e, 'manual', ctx.correlationId, 'user');
      return this.enrollmentById(id);
    });
  }

  /** Launch validation (docs/17): field paths map to translatable keys. */
  private validate(config: CampaignConfig): void {
    const fields: Record<string, string> = {};
    if (config.steps.length === 0) fields.steps = 'steps.required';
    if (config.timezone !== null && !isValidTimeZone(config.timezone)) fields.timezone = 'timezone.invalid';
    config.steps.forEach((step, i) => {
      if (step.type !== 'send_message') return;
      if (!this.channels.has(step.channel)) fields[`steps.${i}.channel`] = 'channel.unavailable';
      if (!step.body.trim()) fields[`steps.${i}.body`] = 'body.required';
      if (unknownPlaceholders(step.subject).length > 0)
        fields[`steps.${i}.subject`] = 'template.unknownField';
      if (unknownPlaceholders(step.body).length > 0) fields[`steps.${i}.body`] = 'template.unknownField';
    });
    if (Object.keys(fields).length > 0) throw RpcError.validation(fields, 'campaign.invalid');
  }

  private setStatus(
    id: string,
    to: CampaignStatus,
    from: CampaignStatus[],
    action: 'campaign.paused' | 'campaign.resumed' | 'campaign.archived',
    ctx: CommandContext,
  ): Campaign {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!from.includes(row.status)) throw conflict(`campaign.${row.status}`);
      this.save(row, { status: to });
      this.record(action, id, ctx);
      return this.get(id);
    });
  }

  private save(
    row: CampaignRow,
    fields: Partial<Pick<CampaignRow, 'name' | 'status' | 'draft_config' | 'active_version_id'>>,
  ): void {
    const entries = Object.entries(fields);
    const result = this.db
      .prepare(
        `UPDATE campaigns SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, lock_version = lock_version + 1, updated_at = ?
         WHERE id = ? AND lock_version = ?`,
      )
      .run(...entries.map(([, v]) => v as string | null), this.now().toISOString(), row.id, row.lock_version);
    if (Number(result.changes) !== 1) throw conflict('campaign.changed');
  }

  private row(id: string): CampaignRow {
    const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
    if (!row) throw notFound('campaign');
    return row;
  }

  private enrollmentRow(id: string): EnrollmentRow {
    const e = this.engine.enrollment(id);
    if (!e) throw notFound('enrollment');
    return e;
  }

  private enrollmentById(id: string): Enrollment {
    const row = this.db
      .prepare(
        `SELECT e.*, c.first_name, c.last_name, c.full_name, c.email FROM campaign_enrollments e
         JOIN contacts c ON c.id = e.contact_id WHERE e.id = ?`,
      )
      .get(id) as unknown as EnrollmentRow & ContactNameRow;
    return this.enrollmentDto(row);
  }

  private enrollmentDto(r: EnrollmentRow & ContactNameRow): Enrollment {
    const version = this.db
      .prepare('SELECT version_number FROM campaign_versions WHERE id = ?')
      .get(r.campaign_version_id) as {
      version_number: number;
    };
    return {
      id: r.id,
      campaignId: r.campaign_id,
      contactId: r.contact_id,
      contactName: displayName(r),
      email: r.email,
      version: version.version_number,
      status: r.status,
      stepPosition: r.current_step_position,
      stepCount: this.engine.stepCount(r.campaign_version_id),
      nextActionAt: r.status === 'active' ? r.next_action_at : null,
      stopReason: r.stop_reason,
      waiting: this.waiting(r),
      updatedAt: r.updated_at,
    };
  }

  private waiting(e: EnrollmentRow): Enrollment['waiting'] {
    if (e.status !== 'active') return null;
    const run = this.engine.openRun(e.id);
    if (run?.status === 'waiting_approval') return 'approval';
    if (run) {
      const job = this.jobs.byDedupeKey(`run:${run.id}`);
      if (job?.type === JOB_RUN && job.status === 'pending') {
        if (job.last_error_class) return 'retry';
        if (new Date(job.run_at) > this.now()) return 'schedule';
      }
      return null;
    }
    return e.next_action_at && new Date(e.next_action_at) > this.now() ? 'schedule' : null;
  }

  private toDto(r: CampaignRow): Campaign {
    const counts = Object.fromEntries(
      (
        this.db
          .prepare(
            'SELECT status, COUNT(*) AS n FROM campaign_enrollments WHERE campaign_id = ? GROUP BY status',
          )
          .all(r.id) as { status: EnrollmentStatus; n: number }[]
      ).map((c) => [c.status, c.n]),
    );
    const pending = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM approvals a JOIN campaign_enrollments e ON e.id = a.campaign_enrollment_id
           WHERE e.campaign_id = ? AND a.status = 'pending'`,
        )
        .get(r.id) as { n: number }
    ).n;
    const version = r.active_version_id
      ? (
          this.db
            .prepare('SELECT version_number FROM campaign_versions WHERE id = ?')
            .get(r.active_version_id) as {
            version_number: number;
          }
        ).version_number
      : null;
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      config: campaignConfigSchema.parse(JSON.parse(r.draft_config)),
      activeVersion: version,
      enrollments: { active: 0, paused: 0, completed: 0, stopped: 0, ...counts },
      pendingApprovals: pending,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private record(
    actionType: Parameters<AuditLog['record']>[0]['actionType'],
    objectId: string,
    ctx: CommandContext,
    payload: Record<string, unknown> = {},
    objectType: 'campaign' | 'enrollment' = 'campaign',
  ): void {
    this.audit.record({
      actorType: 'user',
      actionType,
      objectType,
      objectId,
      payload,
      correlationId: ctx.correlationId,
    });
  }
}

interface ContactNameRow {
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
}

function displayName(r: ContactNameRow): string {
  return r.full_name ?? ([r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '—');
}
