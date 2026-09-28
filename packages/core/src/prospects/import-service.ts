import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type CustomFields,
  type ImportField,
  type ImportPreview,
  type ImportReport,
  type OnMatch,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { CompanyFields, CompanyRow } from './companies.js';
import { ProfileUrlConflictError, type ContactFields, type ContactRow } from './contacts.js';
import { customKey, parseCsv, suggestMapping } from './csv.js';
import {
  normalizeDomain,
  normalizeEmail,
  normalizeProfileUrl,
  splitTags,
  type NormalizedProfileUrl,
} from './normalize.js';
import type { CommandContext, ProspectService } from './prospect-service.js';
import { applyTags, companyTags, contactTags } from './tags.js';

const MAX_REPORTED_ERRORS = 200;
const SAMPLE_ROWS = 20;

/** One CSV row after mapping, before matching. */
interface RowValues {
  company: { name: string | null; website: string | null; country: string | null; city: string | null };
  companyTags: string[];
  companyCustom: CustomFields;
  contact: {
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    email: string | null;
    jobTitle: string | null;
    linkedinUrl: string | null;
  };
  contactTags: string[];
  contactCustom: CustomFields;
}

/** A row that cannot be imported; the message is an error key the UI translates (`errors.*`). */
class InvalidRow extends Error {}

/** Undo the export's formula-injection guard (`'=SUM` -> `=SUM`) so exports re-import cleanly. */
const unescapeCell = (v: string) => (/^'[=+\-@]/.test(v) ? v.slice(1) : v);
const nonEmpty = (v: string | undefined): string | null => {
  const t = v === undefined ? '' : unescapeCell(v).trim();
  return t ? t : null;
};

/** CSV import with preview and deterministic de-duplication (FR-PROS-003..005). */
export class ImportService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly prospects: ProspectService,
    private readonly audit: AuditLog,
  ) {}

  preview(csv: string): ImportPreview {
    const parsed = parseCsv(csv);
    return {
      headers: parsed.headers,
      sampleRows: parsed.rows.slice(0, SAMPLE_ROWS).map((r) => r.cells),
      rowCount: parsed.rows.length,
      suggestedMapping: suggestMapping(parsed.headers),
      delimiter: parsed.delimiter,
    };
  }

  commit(csv: string, mapping: readonly ImportField[], onMatch: OnMatch, ctx: CommandContext): ImportReport {
    const parsed = parseCsv(csv);
    if (mapping.length !== parsed.headers.length) {
      throw RpcError.validation({ mapping: 'import.mappingLength' });
    }
    if (!mapping.some((f) => f !== 'ignore')) throw RpcError.validation({ mapping: 'import.nothingMapped' });

    const importId = uuidv7();
    const report: ImportReport = {
      importId,
      totalRows: parsed.rows.length,
      inserted: 0,
      updated: 0,
      skipped: 0,
      invalid: 0,
      companiesCreated: 0,
      contactsCreated: 0,
      errors: [],
      errorsTruncated: false,
    };

    // The whole file is one transaction: an import either lands completely or not at all.
    transaction(this.db, () => {
      parsed.rows.forEach(({ cells, line }) => {
        try {
          const values = this.mapRow(parsed.headers, cells, mapping);
          const outcome = this.importRow(values, onMatch, importId, ctx);
          report[outcome.result] += 1;
          if (outcome.companyCreated) report.companiesCreated += 1;
          if (outcome.contactCreated) report.contactsCreated += 1;
        } catch (error) {
          if (!(error instanceof InvalidRow)) throw error;
          report.invalid += 1;
          if (report.errors.length < MAX_REPORTED_ERRORS)
            report.errors.push({ row: line, reason: error.message });
          else report.errorsTruncated = true;
        }
      });
      this.audit.record({
        actorType: 'user',
        actionType: 'import.committed',
        objectType: 'import',
        objectId: importId,
        payload: {
          totalRows: report.totalRows,
          inserted: report.inserted,
          updated: report.updated,
          skipped: report.skipped,
          invalid: report.invalid,
          onMatch,
        },
        correlationId: ctx.correlationId,
      });
    });
    return report;
  }

  private mapRow(headers: string[], cells: string[], mapping: readonly ImportField[]): RowValues {
    const v: RowValues = {
      company: { name: null, website: null, country: null, city: null },
      companyTags: [],
      companyCustom: {},
      contact: {
        firstName: null,
        lastName: null,
        fullName: null,
        email: null,
        jobTitle: null,
        linkedinUrl: null,
      },
      contactTags: [],
      contactCustom: {},
    };
    mapping.forEach((field, i) => {
      const value = nonEmpty(cells[i]);
      if (value === null || field === 'ignore') return;
      const header = headers[i] ?? `column${i + 1}`;
      switch (field) {
        case 'company.name':
          v.company.name = value;
          break;
        case 'company.website':
          v.company.website = value;
          break;
        case 'company.country':
          v.company.country = value;
          break;
        case 'company.city':
          v.company.city = value;
          break;
        case 'company.tags':
          v.companyTags.push(...splitTags(value));
          break;
        case 'company.custom':
          v.companyCustom[customKey(header)] = value;
          break;
        case 'contact.firstName':
          v.contact.firstName = value;
          break;
        case 'contact.lastName':
          v.contact.lastName = value;
          break;
        case 'contact.fullName':
          v.contact.fullName = value;
          break;
        case 'contact.email':
          v.contact.email = value;
          break;
        case 'contact.jobTitle':
          v.contact.jobTitle = value;
          break;
        case 'contact.linkedinUrl':
          v.contact.linkedinUrl = value;
          break;
        case 'contact.tags':
          v.contactTags.push(...splitTags(value));
          break;
        case 'contact.custom':
          v.contactCustom[customKey(header)] = value;
          break;
      }
    });
    return v;
  }

  private importRow(
    v: RowValues,
    onMatch: OnMatch,
    importId: string,
    ctx: CommandContext,
  ): { result: 'inserted' | 'updated' | 'skipped'; companyCreated: boolean; contactCreated: boolean } {
    const domain = v.company.website ? normalizeDomain(v.company.website) : null;
    if (v.company.website && !domain) throw new InvalidRow('website.invalid');
    const emailNormalized = v.contact.email ? normalizeEmail(v.contact.email) : null;
    if (v.contact.email && !emailNormalized) throw new InvalidRow('email.invalid');
    let profile: NormalizedProfileUrl | null = null;
    if (v.contact.linkedinUrl) {
      profile = normalizeProfileUrl(v.contact.linkedinUrl);
      if (!profile || profile.channel !== 'linkedin') throw new InvalidRow('linkedin.invalid');
    }
    const personName =
      v.contact.fullName ?? ([v.contact.firstName, v.contact.lastName].filter(Boolean).join(' ') || null);
    const hasCompany = domain !== null || v.company.name !== null;
    const hasContact = emailNormalized !== null || profile !== null || personName !== null;
    if (!hasCompany && !hasContact) throw new InvalidRow('row.empty');

    let companyCreated = false;
    let contactCreated = false;
    let changed = false;

    // Company: domain first, then name among companies without a domain (so acme.com and acme.de,
    // both named "Acme", stay separate), then name among all companies for name-only rows.
    let company: CompanyRow | undefined;
    if (hasCompany) {
      const repo = this.prospects.companies;
      company =
        (domain ? repo.findByDomain(domain) : undefined) ??
        (v.company.name ? repo.findByName(v.company.name, domain !== null) : undefined);
      if (company) {
        if (onMatch !== 'skip') {
          const fields = this.mergeCompany(company, v, domain, onMatch);
          const updated = repo.update(company.id, fields);
          const tagged = applyTags(this.db, companyTags, company.id, v.companyTags, 'add');
          if (tagged) repo.touch(company.id);
          if (updated.length > 0 || tagged) {
            changed = true;
            this.audit.record({
              actorType: 'user',
              actionType: 'company.updated',
              objectType: 'company',
              objectId: company.id,
              payload: { importId, fields: tagged ? [...updated, 'tags'] : updated },
              correlationId: ctx.correlationId,
            });
          }
        }
      } else {
        const id = repo.insert({
          name: v.company.name ?? (domain as string),
          domain,
          websiteUrl: v.company.website,
          country: v.company.country,
          city: v.company.city,
          status: 'active',
          customFields: v.companyCustom,
        });
        applyTags(this.db, companyTags, id, v.companyTags, 'add');
        this.audit.record({
          actorType: 'user',
          actionType: 'company.created',
          objectType: 'company',
          objectId: id,
          payload: { importId },
          correlationId: ctx.correlationId,
        });
        company = repo.get(id);
        companyCreated = true;
      }
    }

    // Contact: email, then LinkedIn profile, then person name within the same company.
    if (hasContact) {
      const repo = this.prospects.contacts;
      const companyId = company?.id ?? null;
      const contact: ContactRow | undefined =
        (emailNormalized ? repo.findByEmail(emailNormalized) : undefined) ??
        (profile ? repo.findByProfile(profile) : undefined) ??
        (personName ? repo.findByName(personName, companyId) : undefined);

      if (contact) {
        if (profile) {
          const owner = repo.findByProfile(profile);
          if (owner && owner.id !== contact.id) throw new InvalidRow('linkedin.duplicate');
        }
        if (onMatch !== 'skip') {
          const updated = repo.update(
            contact.id,
            this.mergeContact(contact, v, emailNormalized, companyId, onMatch),
          );
          const linkedinChanged =
            profile !== null &&
            (onMatch === 'overwrite' || repo.linkedinUrl(contact.id) === null) &&
            this.setProfile(contact.id, profile);
          const tagged = applyTags(this.db, contactTags, contact.id, v.contactTags, 'add');
          if (linkedinChanged || tagged) repo.touch(contact.id);
          const fields = [
            ...updated,
            ...(linkedinChanged ? ['linkedinUrl'] : []),
            ...(tagged ? ['tags'] : []),
          ];
          if (fields.length > 0) {
            changed = true;
            this.audit.record({
              actorType: 'user',
              actionType: 'contact.updated',
              objectType: 'contact',
              objectId: contact.id,
              payload: { importId, fields },
              correlationId: ctx.correlationId,
            });
          }
        }
      } else {
        const id = repo.insert({
          companyId,
          firstName: v.contact.firstName,
          lastName: v.contact.lastName,
          fullName: v.contact.fullName,
          jobTitle: v.contact.jobTitle,
          email: v.contact.email,
          emailNormalized,
          status: 'active',
          customFields: v.contactCustom,
        });
        if (profile) this.setProfile(id, profile);
        applyTags(this.db, contactTags, id, v.contactTags, 'add');
        this.audit.record({
          actorType: 'user',
          actionType: 'contact.created',
          objectType: 'contact',
          objectId: id,
          payload: { importId, companyId },
          correlationId: ctx.correlationId,
        });
        contactCreated = true;
      }
    }

    const result = companyCreated || contactCreated ? 'inserted' : changed ? 'updated' : 'skipped';
    return { result, companyCreated, contactCreated };
  }

  /** fill_empty sets only empty stored fields; overwrite replaces with non-empty imported values. */
  private mergeCompany(
    row: CompanyRow,
    v: RowValues,
    domain: string | null,
    onMatch: 'fill_empty' | 'overwrite',
  ): Partial<CompanyFields> {
    const take = (current: string | null, next: string | null) =>
      next !== null && (onMatch === 'overwrite' || current === null) ? next : undefined;
    const patch: Partial<CompanyFields> = {};
    const name = take(row.name, v.company.name);
    if (name !== undefined && onMatch === 'overwrite') patch.name = name;
    const website = take(row.website_url, v.company.website);
    if (website !== undefined) {
      patch.websiteUrl = website;
      if (domain && (row.domain_normalized === null || onMatch === 'overwrite')) {
        const owner = this.prospects.companies.findByDomain(domain);
        if (!owner || owner.id === row.id) patch.domain = domain;
      }
    }
    const country = take(row.country, v.company.country);
    if (country !== undefined) patch.country = country;
    const city = take(row.city, v.company.city);
    if (city !== undefined) patch.city = city;
    const custom = mergeCustom(row.custom_fields, v.companyCustom, onMatch);
    if (custom) patch.customFields = custom;
    return patch;
  }

  private mergeContact(
    row: ContactRow,
    v: RowValues,
    emailNormalized: string | null,
    companyId: string | null,
    onMatch: 'fill_empty' | 'overwrite',
  ): Partial<ContactFields> {
    const take = (current: string | null, next: string | null) =>
      next !== null && (onMatch === 'overwrite' || current === null) ? next : undefined;
    const patch: Partial<ContactFields> = {};
    const set = <K extends 'firstName' | 'lastName' | 'fullName' | 'jobTitle'>(
      key: K,
      current: string | null,
      next: string | null,
    ) => {
      const value = take(current, next);
      if (value !== undefined) patch[key] = value;
    };
    set('firstName', row.first_name, v.contact.firstName);
    set('lastName', row.last_name, v.contact.lastName);
    set('fullName', row.full_name, v.contact.fullName);
    set('jobTitle', row.job_title, v.contact.jobTitle);
    if (emailNormalized && take(row.email_normalized, emailNormalized) !== undefined) {
      const owner = this.prospects.contacts.findByEmail(emailNormalized);
      if (!owner || owner.id === row.id) {
        patch.email = v.contact.email;
        patch.emailNormalized = emailNormalized;
      }
    }
    if (companyId && take(row.company_id, companyId) !== undefined) patch.companyId = companyId;
    const custom = mergeCustom(row.custom_fields, v.contactCustom, onMatch);
    if (custom) patch.customFields = custom;
    return patch;
  }

  private setProfile(contactId: string, profile: NormalizedProfileUrl): boolean {
    try {
      return this.prospects.contacts.setProfileUrl(contactId, 'linkedin', profile);
    } catch (error) {
      if (error instanceof ProfileUrlConflictError) throw new InvalidRow('linkedin.duplicate');
      throw error;
    }
  }
}

function mergeCustom(
  stored: string,
  incoming: CustomFields,
  onMatch: 'fill_empty' | 'overwrite',
): CustomFields | null {
  if (Object.keys(incoming).length === 0) return null;
  const current = JSON.parse(stored) as CustomFields;
  const next: CustomFields = { ...current };
  for (const [k, value] of Object.entries(incoming)) {
    if (onMatch === 'overwrite' || current[k] === undefined || current[k] === '') next[k] = value;
  }
  return JSON.stringify(next) === stored ? null : next;
}
