import type { DatabaseSync } from 'node:sqlite';
import type { CustomFields } from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import type { CompanyRow } from './companies.js';
import type { ContactRow } from './contacts.js';
import { CUSTOM_PREFIX, toCsv } from './csv.js';
import { companyTags, contactTags, tagsOf } from './tags.js';
import type { CommandContext } from './prospect-service.js';

/** Column names the importer maps back automatically, so an export re-imports as "no changes". */
const BASE_HEADERS = [
  'company_name',
  'company_website',
  'company_country',
  'company_city',
  'company_timezone',
  'company_tags',
  'first_name',
  'last_name',
  'full_name',
  'email',
  'job_title',
  'linkedin_url',
  'timezone',
  'contact_tags',
] as const;

/** CSV export of all prospects: one row per contact, plus one row per company without contacts (FR-PROS-007). */
export class ExportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  exportProspects(ctx: CommandContext): { filename: string; csv: string; rows: number } {
    const companies = this.db
      .prepare('SELECT * FROM companies ORDER BY name_key, id')
      .all() as unknown as CompanyRow[];
    const contacts = this.db
      .prepare('SELECT * FROM contacts ORDER BY company_id, name_key, id')
      .all() as unknown as ContactRow[];
    const byId = new Map(companies.map((c) => [c.id, c]));
    const cTags = tagsOf(
      this.db,
      companyTags,
      companies.map((c) => c.id),
    );
    const pTags = tagsOf(
      this.db,
      contactTags,
      contacts.map((c) => c.id),
    );
    const linkedin = new Map(
      (
        this.db
          .prepare(`SELECT contact_id, url_original FROM contact_profile_urls WHERE channel = 'linkedin'`)
          .all() as { contact_id: string; url_original: string }[]
      ).map((r) => [r.contact_id, r.url_original]),
    );

    const parse = (json: string) => JSON.parse(json) as CustomFields;
    const companyKeys = [...new Set(companies.flatMap((c) => Object.keys(parse(c.custom_fields))))].sort();
    const contactKeys = [...new Set(contacts.flatMap((c) => Object.keys(parse(c.custom_fields))))].sort();
    const headers = [
      ...BASE_HEADERS,
      ...companyKeys.map((k) => `${CUSTOM_PREFIX.company}${k}`),
      ...contactKeys.map((k) => `${CUSTOM_PREFIX.contact}${k}`),
    ];

    const companyCells = (c: CompanyRow | undefined) => {
      const custom = c ? parse(c.custom_fields) : {};
      return {
        base: [
          c?.name ?? '',
          c?.website_url ?? '',
          c?.country ?? '',
          c?.city ?? '',
          c?.timezone ?? '',
          (c ? (cTags.get(c.id) ?? []) : []).join('; '),
        ],
        custom: companyKeys.map((k) => String(custom[k] ?? '')),
      };
    };

    const rows: string[][] = [];
    const withContacts = new Set<string>();
    for (const p of contacts) {
      const company = p.company_id ? byId.get(p.company_id) : undefined;
      if (company) withContacts.add(company.id);
      const cc = companyCells(company);
      const custom = parse(p.custom_fields);
      rows.push([
        ...cc.base,
        p.first_name ?? '',
        p.last_name ?? '',
        p.full_name ?? '',
        p.email ?? '',
        p.job_title ?? '',
        linkedin.get(p.id) ?? '',
        p.timezone ?? '',
        (pTags.get(p.id) ?? []).join('; '),
        ...cc.custom,
        ...contactKeys.map((k) => String(custom[k] ?? '')),
      ]);
    }
    for (const company of companies) {
      if (withContacts.has(company.id)) continue;
      const cc = companyCells(company);
      rows.push([...cc.base, '', '', '', '', '', '', '', '', ...cc.custom, ...contactKeys.map(() => '')]);
    }

    this.audit.record({
      actorType: 'user',
      actionType: 'export.created',
      objectType: 'export',
      payload: { rows: rows.length },
      correlationId: ctx.correlationId,
    });
    const stamp = this.now().toISOString().slice(0, 10);
    // BOM so Excel opens UTF-8 (Cyrillic) correctly.
    return {
      filename: `tabreach-prospects-${stamp}.csv`,
      csv: `\uFEFF${toCsv(headers, rows)}`,
      rows: rows.length,
    };
  }
}
