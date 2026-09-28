import type { DatabaseSync } from 'node:sqlite';
import { uuidv7, type Contact, type CustomFields } from '@tabreach/protocol';
import { likePattern } from './companies.js';
import { nameKey, readCustomFields, searchKey, type NormalizedProfileUrl } from './normalize.js';
import { contactTags, tagsOf } from './tags.js';

export interface ContactRow {
  id: string;
  company_id: string | null;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  job_title: string | null;
  email: string | null;
  email_normalized: string | null;
  email_status: Contact['emailStatus'];
  status: 'active' | 'archived';
  custom_fields: string;
  created_at: string;
  updated_at: string;
}

export interface ContactFields {
  companyId: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  emailNormalized: string | null;
  status: 'active' | 'archived';
  customFields: CustomFields;
}

const columns: Record<Exclude<keyof ContactFields, 'customFields'>, keyof ContactRow> = {
  companyId: 'company_id',
  firstName: 'first_name',
  lastName: 'last_name',
  fullName: 'full_name',
  jobTitle: 'job_title',
  email: 'email',
  emailNormalized: 'email_normalized',
  status: 'status',
};

/** Name used for display and for name-based matching: full name, else first + last. */
export function personName(row: Pick<ContactRow, 'full_name' | 'first_name' | 'last_name'>): string | null {
  const composed = [row.first_name, row.last_name].filter(Boolean).join(' ');
  return row.full_name?.trim() || composed.trim() || null;
}

export class ProfileUrlConflictError extends Error {
  override name = 'ProfileUrlConflictError';
}

export class ContactRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  get(id: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  }

  findByEmail(emailNormalized: string): ContactRow | undefined {
    return this.db.prepare('SELECT * FROM contacts WHERE email_normalized = ?').get(emailNormalized) as
      ContactRow | undefined;
  }

  findByProfile(profile: NormalizedProfileUrl): ContactRow | undefined {
    return this.db
      .prepare(
        `SELECT c.* FROM contacts c JOIN contact_profile_urls p ON p.contact_id = c.id
         WHERE p.channel = ? AND p.url_normalized = ?`,
      )
      .get(profile.channel, profile.normalized) as ContactRow | undefined;
  }

  /** Oldest contact with this person name in the same company (or without a company). */
  findByName(name: string, companyId: string | null): ContactRow | undefined {
    const key = nameKey(name);
    if (!key) return undefined;
    return this.db
      .prepare(
        'SELECT * FROM contacts WHERE company_id IS ? AND name_key = ? ORDER BY created_at, id LIMIT 1',
      )
      .get(companyId, key) as ContactRow | undefined;
  }

  insert(fields: ContactFields): string {
    const id = uuidv7();
    const ts = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, job_title, email, email_normalized,
                               status, custom_fields, created_at, updated_at, name_key, search_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
      )
      .run(
        id,
        fields.companyId,
        fields.firstName,
        fields.lastName,
        fields.fullName,
        fields.jobTitle,
        fields.email,
        fields.emailNormalized,
        fields.status,
        JSON.stringify(fields.customFields),
        ts,
        ts,
      );
    this.refreshKeys(id);
    return id;
  }

  /** Recomputes the Unicode-aware match/search keys from the stored row. */
  private refreshKeys(id: string): void {
    const row = this.get(id);
    if (!row) return;
    this.db
      .prepare('UPDATE contacts SET name_key = ?, search_key = ? WHERE id = ?')
      .run(
        nameKey(personName(row)),
        searchKey([row.full_name, row.first_name, row.last_name, row.email, row.job_title]),
        id,
      );
  }

  update(id: string, patch: Partial<ContactFields>): string[] {
    const row = this.get(id);
    if (!row) throw new Error(`Contact ${id} not found`);
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const changed: string[] = [];
    for (const [field, column] of Object.entries(columns) as [keyof typeof columns, keyof ContactRow][]) {
      const next = patch[field];
      if (next === undefined || next === row[column]) continue;
      sets.push(`${column} = ?`);
      values.push(next);
      if (field !== 'emailNormalized') changed.push(field);
    }
    if (patch.customFields !== undefined) {
      const next = JSON.stringify(patch.customFields);
      if (next !== row.custom_fields) {
        sets.push('custom_fields = ?');
        values.push(next);
        changed.push('customFields');
      }
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, this.now().toISOString(), id);
      this.refreshKeys(id);
    }
    return changed;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(this.now().toISOString(), id);
  }

  /** Normalized profile URL stored for a channel, or null. */
  profileOf(id: string, channel: 'linkedin' | 'other'): string | null {
    const row = this.db
      .prepare('SELECT url_normalized FROM contact_profile_urls WHERE contact_id = ? AND channel = ?')
      .get(id, channel) as { url_normalized: string } | undefined;
    return row?.url_normalized ?? null;
  }

  linkedinUrl(id: string): string | null {
    const row = this.db
      .prepare(`SELECT url_original FROM contact_profile_urls WHERE contact_id = ? AND channel = 'linkedin'`)
      .get(id) as { url_original: string } | undefined;
    return row?.url_original ?? null;
  }

  /**
   * Sets (or clears, with null) the contact's profile URL for one channel. Returns true when it changed.
   * Throws ProfileUrlConflictError when another contact already owns that profile.
   */
  setProfileUrl(id: string, channel: 'linkedin' | 'other', profile: NormalizedProfileUrl | null): boolean {
    const current = this.db
      .prepare('SELECT url_normalized FROM contact_profile_urls WHERE contact_id = ? AND channel = ?')
      .get(id, channel) as { url_normalized: string } | undefined;
    if ((current?.url_normalized ?? null) === (profile?.normalized ?? null)) return false;
    if (profile) {
      const owner = this.findByProfile(profile);
      if (owner && owner.id !== id) {
        throw new ProfileUrlConflictError(`Profile ${profile.normalized} already belongs to another contact`);
      }
    }
    this.db.prepare('DELETE FROM contact_profile_urls WHERE contact_id = ? AND channel = ?').run(id, channel);
    if (profile) {
      this.db
        .prepare(
          'INSERT INTO contact_profile_urls (id, contact_id, channel, url_original, url_normalized) VALUES (?, ?, ?, ?, ?)',
        )
        .run(uuidv7(), id, channel, profile.original, profile.normalized);
    }
    return true;
  }

  list(page: {
    search?: string | undefined;
    companyId?: string | undefined;
    limit: number;
    offset: number;
  }): { rows: ContactRow[]; total: number } {
    const where: string[] = [];
    const params: string[] = [];
    if (page.companyId) {
      where.push('c.company_id = ?');
      params.push(page.companyId);
    }
    if (page.search) {
      const like = likePattern(page.search);
      where.push(`(c.search_key LIKE ? ESCAPE '\\' OR co.search_key LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM contacts c LEFT JOIN companies co ON co.id = c.company_id';
    const total = (this.db.prepare(`SELECT count(*) AS n ${from} ${clause}`).get(...params) as { n: number })
      .n;
    const rows = this.db
      .prepare(
        `SELECT c.* ${from} ${clause}
         ORDER BY coalesce(c.name_key, c.email_normalized, ''), c.id
         LIMIT ? OFFSET ?`,
      )
      .all(...params, page.limit, page.offset) as unknown as ContactRow[];
    return { rows, total };
  }

  toDtos(rows: ContactRow[]): Contact[] {
    const ids = rows.map((r) => r.id);
    const tags = tagsOf(this.db, contactTags, ids);
    const companyIds = [...new Set(rows.map((r) => r.company_id).filter((v): v is string => v !== null))];
    const companyNames = new Map<string, string>();
    const linkedin = new Map<string, string>();
    for (let i = 0; i < companyIds.length; i += 500) {
      const chunk = companyIds.slice(i, i + 500);
      const found = this.db
        .prepare(`SELECT id, name FROM companies WHERE id IN (${chunk.map(() => '?').join(',')})`)
        .all(...chunk) as { id: string; name: string }[];
      for (const c of found) companyNames.set(c.id, c.name);
    }
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const found = this.db
        .prepare(
          `SELECT contact_id, url_original FROM contact_profile_urls
           WHERE channel = 'linkedin' AND contact_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .all(...chunk) as { contact_id: string; url_original: string }[];
      for (const p of found) linkedin.set(p.contact_id, p.url_original);
    }
    return rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      companyName: r.company_id ? (companyNames.get(r.company_id) ?? null) : null,
      firstName: r.first_name,
      lastName: r.last_name,
      fullName: r.full_name,
      displayName: personName(r) ?? r.email ?? '—',
      jobTitle: r.job_title,
      email: r.email,
      emailStatus: r.email_status,
      linkedinUrl: linkedin.get(r.id) ?? null,
      status: r.status,
      tags: tags.get(r.id) ?? [],
      customFields: readCustomFields(r.custom_fields),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
