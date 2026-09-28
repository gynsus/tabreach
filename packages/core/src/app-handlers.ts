import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  silentLogger,
  uiSettingsSchema,
  type ChangedEntity,
  type Logger,
  type RpcPeer,
  type UiSettings,
} from '@tabreach/protocol';
import { AuditLog } from './audit/audit-log.js';
import { ApprovalService } from './campaigns/approval-service.js';
import { CampaignService } from './campaigns/campaign-service.js';
import { CampaignEngine } from './campaigns/engine.js';
import { ContactPolicy } from './campaigns/policy.js';
import type { MessageChannel } from './channels/channel.js';
import { TestChannel } from './channels/test-channel.js';
import { CommandLog } from './commands/command-log.js';
import { JobQueue } from './jobs/queue.js';
import { SideEffectLedger } from './ledger/side-effects.js';
import { ExportService } from './prospects/export-service.js';
import { ImportService } from './prospects/import-service.js';
import { ProspectService } from './prospects/prospect-service.js';
import { SettingsRepository } from './settings/settings.js';
import { SuppressionService } from './suppressions/suppression-service.js';

const UI_SETTINGS_KEY = 'ui';
const DEFAULT_UI: UiSettings = { language: 'en' };

export interface AppServicesOptions {
  now?: () => Date;
  logger?: Logger;
  /** Called after a change so core can tell every window to refetch (event `data.changed`). */
  onChanged?: (entities: ChangedEntity[]) => void;
  /** Called after a job is enqueued so the dispatcher wakes up instead of polling. */
  onJobEnqueued?: () => void;
  /** Sending channels; defaults to the local test channel (the only one before Phase 3). */
  channels?: MessageChannel[];
}

const jobNotFound = () => new RpcError('NOT_FOUND', 'Job not found', 'job.notFound');

/** Domain services behind the app protocol. One instance per core process. */
export class AppServices {
  readonly audit: AuditLog;
  readonly commands: CommandLog;
  readonly prospects: ProspectService;
  readonly imports: ImportService;
  readonly exports: ExportService;
  readonly suppressions: SuppressionService;
  readonly settings: SettingsRepository;
  readonly jobs: JobQueue;
  readonly ledger: SideEffectLedger;
  readonly policy: ContactPolicy;
  readonly engine: CampaignEngine;
  readonly campaigns: CampaignService;
  readonly approvals: ApprovalService;
  private readonly changed: (entities: ChangedEntity[]) => void;

  constructor(db: DatabaseSync, options: AppServicesOptions = {}) {
    const now = options.now ?? (() => new Date());
    const logger = options.logger ?? silentLogger;
    this.changed = options.onChanged ?? (() => {});
    this.audit = new AuditLog(db, now);
    this.commands = new CommandLog(db, now);
    this.jobs = new JobQueue(db, now, options.onJobEnqueued);
    this.ledger = new SideEffectLedger(db, now);
    this.prospects = new ProspectService(db, this.audit, now);
    this.imports = new ImportService(db, this.prospects, this.audit);
    this.exports = new ExportService(db, this.audit, now);
    this.suppressions = new SuppressionService(db, this.audit, now);
    this.settings = new SettingsRepository(db, now, (key) =>
      logger.warn({ event: 'settings.invalid', key }, 'stored setting failed validation; using defaults'),
    );
    const channels = new Map(
      (options.channels ?? [new TestChannel(db, now, 60_000)]).map((c) => [c.channel, c] as const),
    );
    this.policy = new ContactPolicy(db, this.settings, now);
    this.engine = new CampaignEngine({
      db,
      now,
      audit: this.audit,
      jobs: this.jobs,
      ledger: this.ledger,
      policy: this.policy,
      channels,
      logger: logger.child({ component: 'campaigns' }),
      changed: (entities) => this.changed(entities),
    });
    this.campaigns = new CampaignService(db, this.audit, this.engine, this.jobs, channels, now);
    this.approvals = new ApprovalService(db, this.audit, this.engine, this.ledger, now);
  }

  /** Registers every app-channel handler except those owned by CoreService itself (health, browser). */
  register(peer: RpcPeer): RpcPeer {
    const ctx = (c: { correlationId: string }) => ({ correlationId: c.correlationId });
    /** Runs a mutation, then announces which data changed. */
    const mutate = <T>(entities: ChangedEntity[], fn: () => T): T => {
      const result = fn();
      this.changed([...entities, 'activity']);
      return result;
    };
    return peer
      .handle('settings.ui.get', () => this.settings.get(UI_SETTINGS_KEY, uiSettingsSchema) ?? DEFAULT_UI)
      .handle('settings.ui.update', (s) =>
        mutate(['settings'], () => {
          this.settings.set(UI_SETTINGS_KEY, s);
          return s;
        }),
      )
      .handle('companies.list', (p) => this.prospects.listCompanies(p))
      .handle('companies.get', ({ id }) => this.prospects.getCompany(id))
      .handle('companies.create', (p, c) =>
        mutate(['company'], () =>
          this.commands.once(c.idempotencyKey, 'companies.create', () =>
            this.prospects.createCompany(p, ctx(c)),
          ),
        ),
      )
      .handle('companies.update', (p, c) =>
        mutate(['company'], () => this.prospects.updateCompany(p, ctx(c))),
      )
      .handle('contacts.list', (p) => this.prospects.listContacts(p))
      .handle('contacts.get', ({ id }) => this.prospects.getContact(id))
      .handle('contacts.create', (p, c) =>
        mutate(['contact', 'company'], () =>
          this.commands.once(c.idempotencyKey, 'contacts.create', () =>
            this.prospects.createContact(p, ctx(c)),
          ),
        ),
      )
      .handle('contacts.update', (p, c) =>
        mutate(['contact', 'company'], () => this.prospects.updateContact(p, ctx(c))),
      )
      .handle('imports.prospects.preview', ({ csv }) => this.imports.preview(csv))
      .handle('imports.prospects.commit', (p, c) =>
        mutate(['company', 'contact'], () =>
          this.commands.once(c.idempotencyKey, 'imports.prospects.commit', () =>
            this.imports.commit(p.csv, p.mapping, p.onMatch, ctx(c)),
          ),
        ),
      )
      .handle('exports.prospects', (_p, c) => mutate([], () => this.exports.exportProspects(ctx(c))))
      .handle('suppressions.list', (p) => this.suppressions.list(p))
      .handle('suppressions.add', (p, c) =>
        mutate(['suppression'], () => this.suppressions.add(p.kind, p.value, ctx(c))),
      )
      .handle('suppressions.remove', ({ id }, c) =>
        mutate(['suppression'], () => ({ removed: this.suppressions.remove(id, ctx(c)) })),
      )
      .handle('suppressions.import', ({ csv }, c) =>
        mutate(['suppression'], () =>
          this.commands.once(c.idempotencyKey, 'suppressions.import', () =>
            this.suppressions.importCsv(csv, ctx(c)),
          ),
        ),
      )
      .handle('campaigns.list', ({ includeArchived }) => ({ items: this.campaigns.list(includeArchived) }))
      .handle('campaigns.get', ({ id }) => this.campaigns.get(id))
      .handle('campaigns.create', (p, c) =>
        mutate(['campaign'], () =>
          this.commands.once(c.idempotencyKey, 'campaigns.create', () => this.campaigns.create(p, ctx(c))),
        ),
      )
      .handle('campaigns.update', (p, c) => mutate(['campaign'], () => this.campaigns.update(p, ctx(c))))
      .handle('campaigns.launch', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.launch(id, ctx(c))),
      )
      .handle('campaigns.pause', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.pause(id, ctx(c))),
      )
      .handle('campaigns.resume', ({ id }, c) =>
        mutate(['campaign', 'enrollment'], () => this.campaigns.resume(id, ctx(c))),
      )
      .handle('campaigns.archive', ({ id }, c) =>
        mutate(['campaign', 'enrollment', 'approval'], () => this.campaigns.archive(id, ctx(c))),
      )
      .handle('campaigns.enroll', (p, c) =>
        mutate(['campaign', 'enrollment'], () =>
          this.commands.once(c.idempotencyKey, 'campaigns.enroll', () =>
            this.campaigns.enroll(p.campaignId, p.contactIds, ctx(c)),
          ),
        ),
      )
      .handle('enrollments.list', (p) => this.campaigns.listEnrollments(p.campaignId, p))
      .handle('enrollments.pause', ({ id }, c) =>
        mutate(['enrollment', 'campaign'], () => this.campaigns.pauseEnrollment(id, ctx(c))),
      )
      .handle('enrollments.resume', ({ id }, c) =>
        mutate(['enrollment', 'campaign'], () => this.campaigns.resumeEnrollment(id, ctx(c))),
      )
      .handle('enrollments.stop', ({ id }, c) =>
        mutate(['enrollment', 'campaign', 'approval'], () => this.campaigns.stopEnrollment(id, ctx(c))),
      )
      .handle('approvals.pending', ({ campaignId }) => ({ items: this.approvals.pending(campaignId) }))
      .handle('approvals.approve', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.approve(p.approvalId, p.contentHash, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('approvals.reject', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.reject(p.approvalId, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('approvals.skip', (p, c) =>
        mutate(['approval', 'enrollment', 'campaign'], () => {
          this.approvals.skip(p.approvalId, ctx(c));
          return { ok: true as const };
        }),
      )
      .handle('drafts.revise', (p, c) =>
        mutate(['approval'], () => this.approvals.revise(p.draftId, p.subject, p.body, ctx(c))),
      )
      .handle('policy.settings.get', () => this.policy.current())
      .handle('policy.settings.update', (p, c) =>
        mutate(['settings'], () => {
          this.policy.update(p);
          this.audit.record({
            actorType: 'user',
            actionType: 'policy.updated',
            objectType: 'settings',
            correlationId: c.correlationId,
          });
          return p;
        }),
      )
      .handle('jobs.needsAttention', () => ({
        items: this.jobs.needsAttention().map((j) => ({
          id: j.id,
          type: j.type,
          status: j.status,
          attempts: j.attempts,
          lastErrorClass: j.last_error_class,
          lastError: j.last_error_redacted,
          updatedAt: j.updated_at,
        })),
      }))
      .handle('jobs.retry', ({ id }, c) =>
        mutate(['job', 'enrollment'], () => this.jobAction(id, 'retry', c.correlationId)),
      )
      .handle('jobs.dismiss', ({ id }, c) =>
        mutate(['job'], () => this.jobAction(id, 'dismiss', c.correlationId)),
      )
      .handle('activity.list', (p) => ({ items: this.audit.list(p) }));
  }

  private jobAction(id: string, action: 'retry' | 'dismiss', correlationId: string): { ok: true } {
    const done = action === 'retry' ? this.jobs.requeue(id) : this.jobs.dismiss(id);
    if (!done) throw jobNotFound();
    this.audit.record({
      actorType: 'user',
      actionType: action === 'retry' ? 'job.retried' : 'job.dismissed',
      objectType: 'job',
      objectId: id,
      correlationId,
    });
    return { ok: true };
  }
}
