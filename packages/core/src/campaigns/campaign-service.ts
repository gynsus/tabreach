import type { DatabaseSync } from 'node:sqlite';
import {
  campaignConfigSchema,
  type CampaignConfigInput,
  EMPTY_CAMPAIGN_CONFIG,
  RpcError,
  uuidv7,
  type Campaign,
  type CampaignConfig,
  type CampaignPreview,
  type CampaignStatus,
  type Enrollment,
  type EnrollmentStatus,
  type EnrollReport,
  type HumanTask,
  type MigrateReport,
  type Qualification,
  type ResearchBatchReport,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import type { ChannelResolver } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import type { JobQueue } from '../jobs/queue.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import {
  JOB_RUN,
  researchContextOf,
  type CampaignEngine,
  type CampaignEngineDeps,
  type EnrollmentRow,
  type VersionConfig,
} from './engine.js';
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
    private readonly channels: ChannelResolver,
    private readonly now: () => Date,
    /** Whether a reply puts the contact on hold (ContactPolicy.replyHold). */
    private readonly replyHold: (contactId: string, companyId: string | null) => string | null = () => null,
    /** Whether an AI key is stored for the selected provider (AI steps need one). */
    private readonly aiReady: () => boolean = () => false,
    /** LinkedIn launch rules: the adapter on, and `auto` only where opted in (FR-LIN-001/002). */
    private readonly linkedinCheck?: (
      step: Extract<CampaignConfig['steps'][number], { type: 'send_message' }>,
    ) => {
      field: string;
      key: string;
    } | null,
    /** Research asked with the campaign's goal and ICP (docs/16); for "Research companies" and the People list. */
    private readonly research?: CampaignEngineDeps['research'],
    /** AI spending: the campaign's calls and cost, and whether its or the monthly budget is used up. */
    private readonly aiSpend: {
      spend(campaignId: string): Campaign['aiSpend'];
      reached(campaignId: string): boolean;
    } = { spend: () => ({ calls: 0, costUsd: 0 }), reached: () => false },
  ) {}

  /** The campaign's own AI budget, from its launched version (or its draft before launch). */
  aiBudget(id: string): number | null {
    const row = this.db
      .prepare('SELECT active_version_id, draft_config FROM campaigns WHERE id = ?')
      .get(id) as { active_version_id: string | null; draft_config: string } | undefined;
    if (!row) return null;
    return row.active_version_id
      ? this.engine.versionConfig(row.active_version_id).aiBudgetUsd
      : campaignConfigSchema.parse(JSON.parse(row.draft_config)).aiBudgetUsd;
  }

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

  create(input: { name: string; config?: CampaignConfigInput | undefined }, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const id = uuidv7();
      const ts = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO campaigns (id, name, status, draft_config, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?)`,
        )
        .run(
          id,
          input.name,
          JSON.stringify(campaignConfigSchema.parse(input.config ?? EMPTY_CAMPAIGN_CONFIG)),
          ts,
          ts,
        );
      this.record('campaign.created', id, ctx);
      return this.get(id);
    });
  }

  update(
    input: { id: string; name?: string | undefined; config?: CampaignConfigInput | undefined },
    ctx: CommandContext,
  ): Campaign {
    return transaction(this.db, () => {
      const row = this.row(input.id);
      if (row.status === 'archived') throw conflict('campaign.archived');
      this.save(row, {
        name: input.name ?? row.name,
        draft_config: input.config
          ? JSON.stringify(campaignConfigSchema.parse(input.config))
          : row.draft_config,
      });
      this.record('campaign.updated', row.id, ctx, {
        fields: [input.name !== undefined && 'name', input.config !== undefined && 'config'].filter(Boolean),
      });
      return this.get(row.id);
    });
  }

  /** A new draft with this campaign's current draft settings and steps; no versions, no people. */
  clone(input: { id: string; name: string }, ctx: CommandContext): Campaign {
    return transaction(this.db, () => {
      const source = this.row(input.id);
      const id = uuidv7();
      const ts = this.now().toISOString();
      this.db
        .prepare(
          `INSERT INTO campaigns (id, name, status, draft_config, created_at, updated_at)
           VALUES (?, ?, 'draft', ?, ?, ?)`,
        )
        .run(id, input.name, source.draft_config, ts, ts);
      this.record('campaign.cloned', id, ctx, { from: source.id });
      return this.get(id);
    });
  }

  /**
   * The dry run (FR-CAM-008): the launch checks, then the first action for one contact. Nothing is
   * stored; see CampaignEngine.preview.
   */
  async preview(
    input: { campaignId: string; contactId: string; generate: boolean },
    signal: AbortSignal,
    correlationId: string,
  ): Promise<CampaignPreview> {
    const row = this.row(input.campaignId);
    const config = campaignConfigSchema.parse(JSON.parse(row.draft_config));
    this.validate(config);
    const contact = this.db
      .prepare(
        `SELECT first_name, last_name, full_name, email FROM contacts WHERE id = ? AND status = 'active'`,
      )
      .get(input.contactId) as ContactNameRow | undefined;
    if (!contact) throw notFound('contact');
    const { conditions, ...outcome } = await this.engine.preview(
      config,
      input.campaignId,
      input.contactId,
      input.generate,
      signal,
      correlationId,
    );
    const enrolled = this.db
      .prepare('SELECT 1 FROM campaign_enrollments WHERE campaign_id = ? AND contact_id = ?')
      .get(input.campaignId, input.contactId);
    return { contactName: displayName(contact), conditions, alreadyEnrolled: !!enrolled, outcome };
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
      // A paused campaign stays paused: launching changes only takes effect when it resumes.
      const status = row.status === 'paused' ? 'paused' : 'active';
      this.save(row, { status, active_version_id: versionId });
      this.record('campaign.launched', id, ctx, { version: number, steps: steps.length });
      if (status === 'active') this.engine.resync({ campaignId: id });
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

  /**
   * Moves the campaign's live people to its launched version; who cannot move safely stays
   * (docs/17, "Moving people to the current version").
   */
  /**
   * Research for every company of the campaign's people still in it (FR-RES-001, docs/16): asked
   * with the launched version's goal, ICP and instructions; companies with fresh research are left
   * alone. Runs are queued (two at a time); the report counts what happened.
   */
  researchCompanies(id: string, ctx: CommandContext): ResearchBatchReport {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row.active_version_id || (row.status !== 'active' && row.status !== 'paused')) {
        throw conflict('campaign.notLaunched');
      }
      if (!this.aiReady()) throw new RpcError('CONFLICT', 'No AI key', 'ai.no_key');
      if (!this.research) throw new RpcError('UNAVAILABLE', 'Research is not available', 'research.failed');
      const config = this.engine.versionConfig(row.active_version_id);
      const people = this.db
        .prepare(
          `SELECT c.company_id FROM campaign_enrollments e JOIN contacts c ON c.id = e.contact_id
           WHERE e.campaign_id = ? AND e.status IN ('active', 'paused')`,
        )
        .all(id) as { company_id: string | null }[];
      const companies = [...new Set(people.map((p) => p.company_id).filter((c): c is string => c !== null))];
      const report: ResearchBatchReport = {
        companies: companies.length,
        withoutCompany: people.filter((p) => p.company_id === null).length,
        fresh: 0,
        queued: 0,
        noWebsite: 0,
        failed: 0,
        peopleQueued: 0,
        peopleFresh: 0,
      };
      for (const companyId of companies) {
        const need = this.research.need(companyId, researchContextOf(id, config), ctx.correlationId);
        if (need.kind === 'ready') report.fresh++;
        else if (need.kind === 'wait') report.queued++;
        else if (need.reason === 'research.noWebsite') report.noWebsite++;
        else report.failed++;
      }
      if (config.researchContacts) {
        // Each person on their company's site (one without a name is not looked for there).
        const named = this.db
          .prepare(
            `SELECT c.id, c.company_id FROM campaign_enrollments e JOIN contacts c ON c.id = e.contact_id
             WHERE e.campaign_id = ? AND e.status IN ('active', 'paused') AND c.company_id IS NOT NULL`,
          )
          .all(id) as { id: string; company_id: string }[];
        for (const p of named) {
          const need = this.research.need(p.company_id, researchContextOf(id, config), ctx.correlationId, {
            start: true,
            contactId: p.id,
          });
          if (need.kind === 'ready') report.peopleFresh++;
          else if (need.kind === 'wait') report.peopleQueued++;
        }
      }
      this.record('campaign.researched', id, ctx, { ...report });
      return report;
    });
  }

  migrate(id: string, ctx: CommandContext): MigrateReport {
    return transaction(this.db, () => {
      const row = this.row(id);
      if (!row.active_version_id || (row.status !== 'active' && row.status !== 'paused')) {
        throw conflict('campaign.notLaunched');
      }
      const live = this.db
        .prepare(
          `SELECT * FROM campaign_enrollments
           WHERE campaign_id = ? AND status IN ('active', 'paused') AND campaign_version_id <> ?
           ORDER BY created_at, id`,
        )
        .all(id, row.active_version_id) as unknown as EnrollmentRow[];
      const report: MigrateReport = { moved: 0, completed: 0, busy: 0 };
      for (const e of live) {
        const result = this.engine.migrateEnrollment(e, row.active_version_id, ctx.correlationId);
        if (result !== 'current') report[result]++;
      }
      this.record('campaign.migrated', id, ctx, { ...report });
      return report;
    });
  }

  /**
   * Deletes a campaign that was never launched (draft or archived). A launched one has versions,
   * people and send history that duplicate checks and caps rely on; it can only be archived.
   */
  delete(id: string, ctx: CommandContext): void {
    transaction(this.db, () => {
      const row = this.row(id);
      const launched = this.db
        .prepare('SELECT 1 FROM campaign_versions WHERE campaign_id = ? LIMIT 1')
        .get(id);
      if (row.active_version_id || launched) throw conflict('campaign.launched');
      // A dry run that wrote an AI message researched for the campaign: the research stays with
      // the company, and its calls stay in the month's usage, no longer tied to it (audit 8d.5).
      this.db.prepare('UPDATE research_runs SET campaign_id = NULL WHERE campaign_id = ?').run(id);
      this.db.prepare('UPDATE ai_calls SET campaign_id = NULL WHERE campaign_id = ?').run(id);
      this.db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
      this.record('campaign.deleted', id, ctx, { name: row.name });
    });
  }

  enroll(campaignId: string, contactIds: readonly string[], ctx: CommandContext): EnrollReport {
    return transaction(this.db, () => {
      const row = this.row(campaignId);
      if (!row.active_version_id || (row.status !== 'active' && row.status !== 'paused')) {
        throw conflict('campaign.notLaunched');
      }
      const versionId = row.active_version_id;
      const report: EnrollReport = { enrolled: 0, alreadyEnrolled: 0, skipped: 0, onHold: 0 };
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
        if (this.replyHold(contactId, c.company_id)) {
          // They (or their company) replied: not contacted again until the user allows it.
          report.onHold++;
          continue;
        }
        const id = uuidv7();
        const at = this.engine.firstActionAt(versionId, contactId);
        insert.run(id, campaignId, versionId, c.company_id, contactId, at.toISOString(), ts, ts);
        if (row.status === 'active') this.engine.scheduleEnrollment(id, at);
        // Per contact, so the contact's history shows when it joined which campaign.
        this.record('enrollment.created', id, ctx, {}, 'enrollment');
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
  /** Tasks for the person (human_task steps), open ones first, newest last (docs/17). */
  listTasks(
    status: 'open' | 'all',
    page: { limit: number; offset: number },
  ): { items: HumanTask[]; total: number } {
    const where = status === 'open' ? "WHERE t.status = 'open'" : '';
    const rows = this.db
      .prepare(
        `SELECT t.*, e.campaign_id, e.contact_id, cp.name AS campaign_name, c.first_name, c.last_name, c.full_name,
                c.email, co.name AS company_name
         FROM human_tasks t
         JOIN campaign_enrollments e ON e.id = t.campaign_enrollment_id
         JOIN campaigns cp ON cp.id = e.campaign_id
         JOIN contacts c ON c.id = e.contact_id
         LEFT JOIN companies co ON co.id = c.company_id
         ${where} ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END, t.created_at, t.id LIMIT ? OFFSET ?`,
      )
      .all(page.limit, page.offset) as unknown as (ContactNameRow & {
      id: string;
      campaign_enrollment_id: string;
      campaign_id: string;
      contact_id: string;
      campaign_name: string;
      company_name: string | null;
      step_position: number;
      title: string;
      instructions: string;
      status: HumanTask['status'];
      created_at: string;
      resolved_at: string | null;
    })[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM human_tasks t ${where}`).get() as { n: number })
      .n;
    return {
      total,
      items: rows.map((r) => ({
        id: r.id,
        enrollmentId: r.campaign_enrollment_id,
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        contactId: r.contact_id,
        contactName: displayName(r),
        email: r.email,
        companyName: r.company_name,
        stepPosition: r.step_position,
        title: r.title,
        instructions: r.instructions,
        status: r.status,
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      })),
    };
  }

  resolveTask(id: string, outcome: 'done' | 'skip' | 'stop', ctx: CommandContext): void {
    this.engine.resolveTask(id, outcome, ctx.correlationId);
  }

  private validate(config: CampaignConfig): void {
    const fields: Record<string, string> = {};
    config.steps.forEach((step, i) => {
      if (step.type !== 'human_task') return;
      if (!step.title.trim()) fields[`steps.${i}.title`] = 'task.titleRequired';
      else if (unknownPlaceholders(step.title).length > 0)
        fields[`steps.${i}.title`] = 'template.unknownField';
      if (unknownPlaceholders(step.instructions).length > 0)
        fields[`steps.${i}.instructions`] = 'template.unknownField';
    });
    config.steps.forEach((step, i) => {
      // A research condition needs research, and research needs an AI key: without one every person would stop.
      if (step.type === 'condition' && step.conditions.some((c) => c.field === 'research.qualification')) {
        // "contains match" would also hold for possible_match and not_match (audit 8d.5).
        if (step.conditions.some((c) => c.field === 'research.qualification' && c.op === 'contains'))
          fields[`steps.${i}.conditions`] = 'campaign.qualificationOp';
        else if (!this.aiReady()) fields[`steps.${i}.conditions`] = 'ai.keyRequired';
        else if (step.conditions.some((c) => c.field === 'research.qualification' && !config.icp.trim()))
          fields[`steps.${i}.conditions`] = 'campaign.icpRequired';
      }
    });
    if (config.steps.length === 0) fields.steps = 'steps.required';
    if (config.timezone !== null && !isValidTimeZone(config.timezone)) fields.timezone = 'timezone.invalid';
    config.steps.forEach((step, i) => {
      if (step.type !== 'send_message') return;
      if (step.channel === 'email' && !config.emailAccountId) fields.emailAccountId = 'account.required';
      else if (!this.channels(step.channel, config)) {
        if (step.channel === 'email') fields.emailAccountId = 'account.unavailable';
        else if (step.channel === 'web_form') fields[`steps.${i}.channel`] = 'forms.senderRequired';
        else if (step.channel === 'linkedin') fields[`steps.${i}.channel`] = 'linkedin.disabled';
        else fields[`steps.${i}.channel`] = 'channel.unavailable';
      }
      // Only a browser channel has a person press the final button (docs/01 "Execution modes").
      if (step.channel !== 'web_form' && step.channel !== 'linkedin' && step.executionMode !== 'auto')
        fields[`steps.${i}.executionMode`] = 'mode.autoOnly';
      // A website form is pressed by TabReach or by the person in assisted mode; `manual` is LinkedIn's.
      else if (step.channel === 'web_form' && step.executionMode === 'manual')
        fields[`steps.${i}.executionMode`] = 'mode.manualUnsupported';
      if (step.channel === 'linkedin') {
        const off = this.linkedinCheck?.(step);
        if (off) fields[off.field.replace('{i}', String(i))] = off.key;
        // LinkedIn invitation notes are short; a longer template is refused before launch.
        if (step.linkedinAction === 'connect' && step.mode === 'template' && step.body.length > 300)
          fields[`steps.${i}.body`] = 'linkedin.noteTooLong';
      }
      if (step.mode === 'ai') {
        if (!step.instructions.trim()) fields[`steps.${i}.instructions`] = 'instructions.required';
        if (!this.aiReady()) fields[`steps.${i}.mode`] = 'ai.keyRequired';
        if (unknownPlaceholders(step.signature).length > 0)
          fields[`steps.${i}.signature`] = 'template.unknownField';
        return;
      }
      // An invitation may go without a note.
      if (!step.body.trim() && !(step.channel === 'linkedin' && step.linkedinAction === 'connect'))
        fields[`steps.${i}.body`] = 'body.required';
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
      qualification: this.qualification(r),
      ...this.waiting(r),
      updatedAt: r.updated_at,
    };
  }

  /** The company's qualification by research with this version's context, if there is any (nothing is started). */
  private qualification(r: EnrollmentRow): Qualification | null {
    if (!this.research || !r.company_id) return null;
    const need = this.research.need(
      r.company_id,
      researchContextOf(r.campaign_id, this.engine.versionConfig(r.campaign_version_id)),
      'people-list',
      { start: false },
    );
    if (need.kind === 'ready') return need.run.qualification;
    return need.kind === 'unavailable' ? (need.stale?.qualification ?? null) : null;
  }

  private waiting(e: EnrollmentRow): Pick<Enrollment, 'waiting' | 'sendingHours'> {
    const none = { waiting: null, sendingHours: null };
    if (e.status !== 'active') return none;
    // Scheduled for later: by the sending hours, or by a delay or a cap.
    const later = (at: Date): Pick<Enrollment, 'waiting' | 'sendingHours'> => {
      const hours = this.engine.heldByWindow(e, at);
      return hours ? { waiting: 'window', sendingHours: hours } : { waiting: 'schedule', sendingHours: null };
    };
    const run = this.engine.openRun(e.id);
    if (run?.status === 'waiting_approval') return { waiting: 'approval', sendingHours: null };
    // An AI message or a research condition held by a used-up AI budget (docs/15 "Budgets").
    const step = this.engine.step(e.campaign_version_id, e.current_step_position);
    const needsAi = run
      ? run.current_state === 'GENERATE_DRAFT'
      : step?.type === 'condition' && step.conditions.some((c) => c.field === 'research.qualification');
    if (needsAi && this.aiSpend.reached(e.campaign_id)) return { waiting: 'budget', sendingHours: null };
    if (!run && step?.type === 'human_task' && this.engine.openTask(e.id, e.current_step_position))
      return { waiting: 'task', sendingHours: null };
    if (run) {
      const job = this.jobs.byDedupeKey(`run:${run.id}`);
      if (job?.type === JOB_RUN && job.status === 'pending') {
        if (job.last_error_class) return { waiting: 'retry', sendingHours: null };
        if (new Date(job.run_at) > this.now()) return later(new Date(job.run_at));
      }
      return none;
    }
    return e.next_action_at && new Date(e.next_action_at) > this.now()
      ? later(new Date(e.next_action_at))
      : none;
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
      aiSpend: this.aiSpend.spend(r.id),
      results: this.db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM side_effects s JOIN campaign_enrollments e ON e.id = s.scope_id
               WHERE e.campaign_id = ? AND s.status = 'completed') AS sent,
             (SELECT COUNT(*) FROM campaign_enrollments
               WHERE campaign_id = ? AND last_reply_at IS NOT NULL) AS replied`,
        )
        .get(r.id, r.id) as Campaign['results'],
      outdatedEnrollments: r.active_version_id
        ? (
            this.db
              .prepare(
                `SELECT COUNT(*) AS n FROM campaign_enrollments
                 WHERE campaign_id = ? AND status IN ('active', 'paused') AND campaign_version_id <> ?`,
              )
              .get(r.id, r.active_version_id) as { n: number }
          ).n
        : 0,
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
