import type { DatabaseSync } from 'node:sqlite';
import { uiSettingsSchema, type RpcPeer, type UiSettings } from '@tabreach/protocol';
import { AuditLog } from './audit/audit-log.js';
import { ExportService } from './prospects/export-service.js';
import { ImportService } from './prospects/import-service.js';
import { ProspectService } from './prospects/prospect-service.js';
import { SettingsRepository } from './settings/settings.js';
import { SuppressionService } from './suppressions/suppression-service.js';

const UI_SETTINGS_KEY = 'ui';
const DEFAULT_UI: UiSettings = { language: 'en' };

/** Domain services behind the app protocol. One instance per core process. */
export class AppServices {
  readonly audit: AuditLog;
  readonly prospects: ProspectService;
  readonly imports: ImportService;
  readonly exports: ExportService;
  readonly suppressions: SuppressionService;
  readonly settings: SettingsRepository;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.audit = new AuditLog(db, now);
    this.prospects = new ProspectService(db, this.audit, now);
    this.imports = new ImportService(db, this.prospects, this.audit);
    this.exports = new ExportService(db, this.audit, now);
    this.suppressions = new SuppressionService(db, this.audit, now);
    this.settings = new SettingsRepository(db, now);
  }

  /** Registers every app-channel handler except those owned by CoreService itself (health, browser). */
  register(peer: RpcPeer): RpcPeer {
    const ctx = (c: { correlationId: string }) => ({ correlationId: c.correlationId });
    return peer
      .handle('settings.ui.get', () => this.settings.get(UI_SETTINGS_KEY, uiSettingsSchema) ?? DEFAULT_UI)
      .handle('settings.ui.update', (s) => {
        this.settings.set(UI_SETTINGS_KEY, s);
        return s;
      })
      .handle('companies.list', (p) => this.prospects.listCompanies(p))
      .handle('companies.get', ({ id }) => this.prospects.getCompany(id))
      .handle('companies.create', (p, c) => this.prospects.createCompany(p, ctx(c)))
      .handle('companies.update', (p, c) => this.prospects.updateCompany(p, ctx(c)))
      .handle('contacts.list', (p) => this.prospects.listContacts(p))
      .handle('contacts.get', ({ id }) => this.prospects.getContact(id))
      .handle('contacts.create', (p, c) => this.prospects.createContact(p, ctx(c)))
      .handle('contacts.update', (p, c) => this.prospects.updateContact(p, ctx(c)))
      .handle('imports.prospects.preview', ({ csv }) => this.imports.preview(csv))
      .handle('imports.prospects.commit', (p, c) => this.imports.commit(p.csv, p.mapping, p.onMatch, ctx(c)))
      .handle('exports.prospects', (_p, c) => this.exports.exportProspects(ctx(c)))
      .handle('suppressions.list', (p) => this.suppressions.list(p))
      .handle('suppressions.add', (p, c) => this.suppressions.add(p.kind, p.value, ctx(c)))
      .handle('suppressions.remove', ({ id }, c) => ({ removed: this.suppressions.remove(id, ctx(c)) }))
      .handle('suppressions.import', ({ csv }, c) => this.suppressions.importCsv(csv, ctx(c)))
      .handle('activity.list', (p) => ({ items: this.audit.list(p) }));
  }
}
