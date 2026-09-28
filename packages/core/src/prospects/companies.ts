import type { DatabaseSync } from 'node:sqlite';
import { customFieldsSchema, uuidv7, type Company, type CustomFields } from '@tabreach/protocol';
import { nameKey, searchKey } from './normalize.js';
import { companyTags, tagsOf } from './tags.js';

export interface CompanyRow {
  id: string;
  name: string;
  domain_normalized: string | null;
  website_url: string | null;
  country: string | null;
  city: string | null;
  status: 'active' | 'archived';
  custom_fields: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyFields {
  name: string;
  domain: string | null;
  websiteUrl: string | null;
  country: string | null;
  city: string | null;
  status: 'active' | 'archived';
  customFields: CustomFields;
}

const columns: Record<Exclude<keyof CompanyFields, 'customFields'>, keyof CompanyRow> = {
  name: 'name',
  domain: 'domain_normalized',
  websiteUrl: 'website_url',
  country: 'country',
  city: 'city',
  status: 'status',
};

/** LIKE pattern over a search key; the query is folded the same way as the stored key. */
export function likePattern(search: string): string {
  return `%${searchKey([search]).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class CompanyRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  get(id: string): CompanyRow | undefined {
    return this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined;
  }

  findByDomain(domain: string): CompanyRow | undefined {
    return this.db.prepare('SELECT * FROM companies WHERE domain_normalized = ?').get(domain) as
      CompanyRow | undefined;
  }

  /**
   * Oldest company with this name (case/space-insensitive). `withoutDomainOnly` keeps a row that has
   * a domain from merging into a same-named company on a different domain.
   */
  findByName(name: string, withoutDomainOnly: boolean): CompanyRow | undefined {
    const key = nameKey(name);
    if (!key) return undefined;
    return this.db
      .prepare(
        `SELECT * FROM companies
         WHERE name_key = ? ${withoutDomainOnly ? 'AND domain_normalized IS NULL' : ''}
         ORDER BY created_at, id LIMIT 1`,
      )
      .get(key) as CompanyRow | undefined;
  }

  insert(fields: CompanyFields): string {
    const id = uuidv7();
    const ts = this.now().toISOString();
    this.db
      .prepare(
        `INSERT INTO companies (id, name, name_key, search_key, domain_normalized, website_url, country, city,
                                status, custom_fields, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        nameKey(fields.name) ?? '',
        searchKey([fields.name, fields.domain]),
        fields.domain,
        fields.websiteUrl,
        fields.country,
        fields.city,
        fields.status,
        JSON.stringify(fields.customFields),
        ts,
        ts,
      );
    return id;
  }

  /** Applies a patch; returns the names of fields whose stored value actually changed. */
  update(id: string, patch: Partial<CompanyFields>): string[] {
    const row = this.get(id);
    if (!row) throw new Error(`Company ${id} not found`);
    const sets: string[] = [];
    const values: (string | null)[] = [];
    const changed: string[] = [];
    for (const [field, column] of Object.entries(columns) as [keyof typeof columns, keyof CompanyRow][]) {
      const next = patch[field];
      if (next === undefined || next === row[column]) continue;
      sets.push(`${column} = ?`);
      values.push(next);
      changed.push(field);
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
        .prepare(`UPDATE companies SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, this.now().toISOString(), id);
      const next = this.get(id);
      if (next) {
        this.db
          .prepare('UPDATE companies SET name_key = ?, search_key = ? WHERE id = ?')
          .run(nameKey(next.name) ?? '', searchKey([next.name, next.domain_normalized]), id);
      }
    }
    return changed;
  }

  touch(id: string): void {
    this.db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(this.now().toISOString(), id);
  }

  list(page: { search?: string | undefined; limit: number; offset: number }): {
    rows: CompanyRow[];
    total: number;
  } {
    const where = page.search ? `WHERE search_key LIKE ? ESCAPE '\\'` : '';
    const params = page.search ? [likePattern(page.search)] : [];
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM companies ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM companies ${where} ORDER BY name_key, id LIMIT ? OFFSET ?`)
      .all(...params, page.limit, page.offset) as unknown as CompanyRow[];
    return { rows, total };
  }

  toDtos(rows: CompanyRow[]): Company[] {
    const ids = rows.map((r) => r.id);
    const tags = tagsOf(this.db, companyTags, ids);
    const counts = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const found = this.db
        .prepare(
          `SELECT company_id, count(*) AS n FROM contacts WHERE company_id IN (${chunk.map(() => '?').join(',')})
           GROUP BY company_id`,
        )
        .all(...chunk) as { company_id: string; n: number }[];
      for (const c of found) counts.set(c.company_id, c.n);
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      domain: r.domain_normalized,
      websiteUrl: r.website_url,
      country: r.country,
      city: r.city,
      status: r.status,
      tags: tags.get(r.id) ?? [],
      customFields: customFieldsSchema.parse(JSON.parse(r.custom_fields)),
      contactCount: counts.get(r.id) ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
}
