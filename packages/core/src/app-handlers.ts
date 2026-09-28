import type { DatabaseSync } from 'node:sqlite';
import {
  silentLogger,
  uiSettingsSchema,
  type ChangedEntity,
  type Logger,
  type RpcPeer,
  type UiSettings,
} from '@tabreach/protocol';
import { AuditLog } from './audit/audit-log.js';
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
}

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
      .handle('activity.list', (p) => ({ items: this.audit.list(p) }));
  }
}
