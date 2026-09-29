import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  type Company,
  type CompanyDetail,
  type CompanyInput,
  type CompanyUpdate,
  type Contact,
  type ContactInput,
  type ContactUpdate,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { isValidTimeZone } from '../campaigns/schedule.js';
import { transaction } from '../db/database.js';
import { CompanyRepository, type CompanyFields } from './companies.js';
import { ContactRepository, ProfileUrlConflictError, type ContactFields } from './contacts.js';
import {
  cleanTags as cleanTagList,
  normalizeDomain,
  normalizeEmail,
  normalizeProfileUrl,
} from './normalize.js';
import { applyTags, companyTags, contactTags } from './tags.js';

export interface CommandContext {
  correlationId: string;
}

const empty = (v: string | null | undefined): string | null => (v?.trim() ? v.trim() : null);
/** An IANA time zone, or null when empty; anything else is a field error. */
function timeZone(value: string | null | undefined): string | null {
  const zone = empty(value);
  if (zone && !isValidTimeZone(zone)) throw RpcError.validation({ timezone: 'timezone.invalid' });
  return zone;
}
const cleanTags = (tags: readonly string[] | undefined) => (tags ? cleanTagList(tags) : undefined);

/** Manual create/edit of companies and contacts (FR-PROS-001, -002, -006). */
export class ProspectService {
  readonly companies: CompanyRepository;
  readonly contacts: ContactRepository;

  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    now: () => Date = () => new Date(),
  ) {
    this.companies = new CompanyRepository(db, now);
    this.contacts = new ContactRepository(db, now);
  }

  listCompanies(page: { search?: string | undefined; limit: number; offset: number }) {
    const { rows, total } = this.companies.list(page);
    return { items: this.companies.toDtos(rows), total };
  }

  getCompany(id: string): CompanyDetail {
    const row = this.companies.get(id);
    if (!row) throw notFound('company');
    const [company] = this.companies.toDtos([row]);
    const { rows } = this.contacts.list({ companyId: id, limit: 500, offset: 0 });
    return { ...(company as Company), contacts: this.contacts.toDtos(rows) };
  }

  createCompany(input: CompanyInput, ctx: CommandContext): Company {
    const fields = this.companyFields(input);
    return transaction(this.db, () => {
      this.assertDomainFree(fields.domain, null);
      const id = this.companies.insert(fields);
      if (input.tags) applyTags(this.db, companyTags, id, cleanTags(input.tags) ?? [], 'replace');
      this.audit.record({
        actorType: 'user',
        actionType: 'company.created',
        objectType: 'company',
        objectId: id,
        correlationId: ctx.correlationId,
      });
      return this.companyDto(id);
    });
  }

  updateCompany(input: CompanyUpdate, ctx: CommandContext): Company {
    return transaction(this.db, () => {
      if (!this.companies.get(input.id)) throw notFound('company');
      const patch: Partial<CompanyFields> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.website !== undefined) {
        const website = empty(input.website);
        patch.websiteUrl = website;
        patch.domain = website ? this.requireDomain(website) : null;
        this.assertDomainFree(patch.domain, input.id);
      }
      if (input.country !== undefined) patch.country = empty(input.country);
      if (input.city !== undefined) patch.city = empty(input.city);
      if (input.timezone !== undefined) patch.timezone = timeZone(input.timezone);
      if (input.status !== undefined) patch.status = input.status;
      if (input.customFields !== undefined) patch.customFields = input.customFields;
      const changed = this.companies.update(input.id, patch);
      if (
        input.tags !== undefined &&
        applyTags(this.db, companyTags, input.id, cleanTags(input.tags) ?? [], 'replace')
      ) {
        changed.push('tags');
        this.companies.touch(input.id);
      }
      if (changed.length > 0) {
        this.audit.record({
          actorType: 'user',
          actionType: 'company.updated',
          objectType: 'company',
          objectId: input.id,
          payload: { fields: changed },
          correlationId: ctx.correlationId,
        });
      }
      return this.companyDto(input.id);
    });
  }

  listContacts(page: {
    search?: string | undefined;
    companyId?: string | undefined;
    limit: number;
    offset: number;
  }) {
    const { rows, total } = this.contacts.list(page);
    return { items: this.contacts.toDtos(rows), total };
  }

  getContact(id: string): Contact {
    const row = this.contacts.get(id);
    if (!row) throw notFound('contact');
    return this.contacts.toDtos([row])[0] as Contact;
  }

  createContact(input: ContactInput, ctx: CommandContext): Contact {
    const email = empty(input.email);
    const emailNormalized = email ? normalizeEmail(email) : null;
    if (email && !emailNormalized) throw RpcError.validation({ email: 'email.invalid' });
    const linkedin = this.parseLinkedin(input.linkedinUrl);
    const fields: ContactFields = {
      companyId: input.companyId ?? null,
      firstName: empty(input.firstName),
      lastName: empty(input.lastName),
      fullName: empty(input.fullName),
      jobTitle: empty(input.jobTitle),
      email,
      emailNormalized,
      timezone: timeZone(input.timezone),
      status: 'active',
      customFields: input.customFields ?? {},
    };
    if (!fields.firstName && !fields.lastName && !fields.fullName && !email && !linkedin) {
      throw RpcError.validation({ fullName: 'contact.identityRequired' });
    }
    return transaction(this.db, () => {
      if (fields.companyId && !this.companies.get(fields.companyId)) {
        throw RpcError.validation({ companyId: 'company.notFound' });
      }
      if (emailNormalized && this.contacts.findByEmail(emailNormalized)) {
        throw RpcError.validation({ email: 'email.duplicate' });
      }
      const id = this.contacts.insert(fields);
      this.setLinkedin(id, linkedin);
      if (input.tags) applyTags(this.db, contactTags, id, cleanTags(input.tags) ?? [], 'replace');
      this.audit.record({
        actorType: 'user',
        actionType: 'contact.created',
        objectType: 'contact',
        objectId: id,
        payload: { companyId: fields.companyId },
        correlationId: ctx.correlationId,
      });
      return this.getContact(id);
    });
  }

  updateContact(input: ContactUpdate, ctx: CommandContext): Contact {
    return transaction(this.db, () => {
      const row = this.contacts.get(input.id);
      if (!row) throw notFound('contact');
      const patch: Partial<ContactFields> = {};
      if (input.companyId !== undefined) {
        if (input.companyId && !this.companies.get(input.companyId)) {
          throw RpcError.validation({ companyId: 'company.notFound' });
        }
        patch.companyId = input.companyId ?? null;
      }
      if (input.firstName !== undefined) patch.firstName = empty(input.firstName);
      if (input.lastName !== undefined) patch.lastName = empty(input.lastName);
      if (input.fullName !== undefined) patch.fullName = empty(input.fullName);
      if (input.jobTitle !== undefined) patch.jobTitle = empty(input.jobTitle);
      if (input.timezone !== undefined) patch.timezone = timeZone(input.timezone);
      if (input.status !== undefined) patch.status = input.status;
      if (input.customFields !== undefined) patch.customFields = input.customFields;
      if (input.email !== undefined) {
        const email = empty(input.email);
        const normalized = email ? normalizeEmail(email) : null;
        if (email && !normalized) throw RpcError.validation({ email: 'email.invalid' });
        const owner = normalized ? this.contacts.findByEmail(normalized) : undefined;
        if (owner && owner.id !== input.id) throw RpcError.validation({ email: 'email.duplicate' });
        patch.email = email;
        patch.emailNormalized = normalized;
      }
      const changed = this.contacts.update(input.id, patch);
      if (
        input.linkedinUrl !== undefined &&
        this.setLinkedin(input.id, this.parseLinkedin(input.linkedinUrl))
      ) {
        changed.push('linkedinUrl');
        this.contacts.touch(input.id);
      }
      if (
        input.tags !== undefined &&
        applyTags(this.db, contactTags, input.id, cleanTags(input.tags) ?? [], 'replace')
      ) {
        changed.push('tags');
        this.contacts.touch(input.id);
      }
      if (changed.length > 0) {
        this.audit.record({
          actorType: 'user',
          actionType: 'contact.updated',
          objectType: 'contact',
          objectId: input.id,
          payload: { fields: changed },
          correlationId: ctx.correlationId,
        });
      }
      return this.getContact(input.id);
    });
  }

  private companyFields(input: CompanyInput): CompanyFields {
    const website = empty(input.website);
    return {
      name: input.name.trim(),
      websiteUrl: website,
      domain: website ? this.requireDomain(website) : null,
      country: empty(input.country),
      city: empty(input.city),
      timezone: timeZone(input.timezone),
      status: 'active',
      customFields: input.customFields ?? {},
    };
  }

  private requireDomain(website: string): string {
    const domain = normalizeDomain(website);
    if (!domain) throw RpcError.validation({ website: 'website.invalid' });
    return domain;
  }

  private assertDomainFree(domain: string | null | undefined, exceptId: string | null): void {
    if (!domain) return;
    const owner = this.companies.findByDomain(domain);
    if (owner && owner.id !== exceptId)
      throw RpcError.validation({ website: 'website.duplicate' }, owner.name);
  }

  private parseLinkedin(value: string | null | undefined) {
    const raw = empty(value);
    if (!raw) return null;
    const profile = normalizeProfileUrl(raw);
    if (!profile || profile.channel !== 'linkedin')
      throw RpcError.validation({ linkedinUrl: 'linkedin.invalid' });
    return profile;
  }

  private setLinkedin(id: string, profile: ReturnType<ProspectService['parseLinkedin']>): boolean {
    try {
      return this.contacts.setProfileUrl(id, 'linkedin', profile);
    } catch (error) {
      if (error instanceof ProfileUrlConflictError)
        throw RpcError.validation({ linkedinUrl: 'linkedin.duplicate' });
      throw error;
    }
  }

  private companyDto(id: string): Company {
    const row = this.companies.get(id);
    if (!row) throw notFound('company');
    return this.companies.toDtos([row])[0] as Company;
  }
}

function notFound(what: 'company' | 'contact'): RpcError {
  return RpcError.validation({ id: `${what}.notFound` }, `${what} not found`);
}
