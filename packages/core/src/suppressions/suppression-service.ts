import { domainToUnicode } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { RpcError, uuidv7, type Suppression, type SuppressionKind } from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import { likePattern } from '../prospects/companies.js';
import { parseCsv } from '../prospects/csv.js';
import { normalizeDomain, normalizeEmail, normalizeProfileUrl, searchKey } from '../prospects/normalize.js';
import type { CommandContext } from '../prospects/prospect-service.js';

interface Row {
  id: string;
  kind: SuppressionKind;
  value_original: string;
  value_normalized: string;
  reason: Suppression['reason'];
  created_at: string;
}

const toDto = (r: Row): Suppression => ({
  id: r.id,
  kind: r.kind,
  value: r.value_original,
  reason: r.reason,
  createdAt: r.created_at,
});

/**
 * Do-not-contact list (FR-POL-001). Enforcement at send time arrives with the workflow engine
 * (Phase 2); values are normalized with the same functions the matcher will use.
 */
export class SuppressionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Normalized value for a kind, or null when the value is not valid for that kind. */
  normalize(kind: SuppressionKind, value: string): { normalized: string; original: string } | null {
    const original = value.trim();
    switch (kind) {
      case 'email': {
        const n = normalizeEmail(original);
        return n ? { normalized: n, original } : null;
      }
      case 'domain': {
        // Matched in punycode, shown (and searched) in Unicode: `xn--e1afmkfd.xn--p1ai` reads as `пример.рф`.
        const n = normalizeDomain(original);
        return n ? { normalized: n, original: domainToUnicode(n) } : null;
      }
      case 'profile_url': {
        const n = normalizeProfileUrl(original);
        return n ? { normalized: `${n.channel}:${n.normalized}`, original } : null;
      }
      case 'company': {
        const company = this.db.prepare('SELECT id, name FROM companies WHERE id = ?').get(original) as
          { id: string; name: string } | undefined;
        return company ? { normalized: company.id, original: company.name } : null;
      }
    }
  }

  list(page: { search?: string | undefined; limit: number; offset: number }) {
    const where = page.search ? `WHERE search_key LIKE ? ESCAPE '\\'` : '';
    const params = page.search ? [likePattern(page.search)] : [];
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM suppressions ${where}`).get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM suppressions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, page.limit, page.offset) as unknown as Row[];
    return { items: rows.map(toDto), total };
  }

  /** Idempotent: adding an existing entry returns it unchanged. */
  add(kind: SuppressionKind, value: string, ctx: CommandContext): Suppression {
    const n = this.normalize(kind, value);
    if (!n) throw RpcError.validation({ value: `suppression.invalid.${kind}` });
    return transaction(this.db, () => this.insert(kind, n, 'manual', ctx).row);
  }

  remove(id: string, ctx: CommandContext): boolean {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM suppressions WHERE id = ?').get(id) as Row | undefined;
      if (!row) return false;
      this.db.prepare('DELETE FROM suppressions WHERE id = ?').run(id);
      this.audit.record({
        actorType: 'user',
        actionType: 'suppression.removed',
        objectType: 'suppression',
        objectId: id,
        payload: { kind: row.kind },
        correlationId: ctx.correlationId,
      });
      return true;
    });
  }

  /**
   * Imports the first column of a CSV. The kind is detected per value: `@` means email, a URL
   * means profile URL, anything else is tried as a domain. A header row is skipped if it is not a value.
   */
  importCsv(csv: string, ctx: CommandContext): { added: number; alreadyPresent: number; invalid: number } {
    const parsed = parseCsv(csv);
    const values = [parsed.headers[0] ?? '', ...parsed.rows.map((r) => r.cells[0] ?? '')];
    const counts = { added: 0, alreadyPresent: 0, invalid: 0 };
    transaction(this.db, () => {
      values.forEach((raw, i) => {
        const value = raw.trim();
        if (!value) return;
        const kind = detectKind(value);
        const n = this.normalize(kind, value);
        if (!n) {
          // The first cell is usually a header such as "email"; don't count it as invalid.
          if (i > 0) counts.invalid += 1;
          return;
        }
        if (this.insert(kind, n, 'imported', ctx).created) counts.added += 1;
        else counts.alreadyPresent += 1;
      });
    });
    return counts;
  }

  private insert(
    kind: SuppressionKind,
    n: { normalized: string; original: string },
    reason: Suppression['reason'],
    ctx: CommandContext,
  ): { row: Suppression; created: boolean } {
    const existing = this.db
      .prepare('SELECT * FROM suppressions WHERE kind = ? AND value_normalized = ?')
      .get(kind, n.normalized) as Row | undefined;
    if (existing) return { row: toDto(existing), created: false };
    const row: Row = {
      id: uuidv7(),
      kind,
      value_original: n.original,
      value_normalized: n.normalized,
      reason,
      created_at: this.now().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO suppressions (id, kind, value_original, value_normalized, reason, created_at, search_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.kind,
        row.value_original,
        row.value_normalized,
        row.reason,
        row.created_at,
        searchKey([row.value_original, row.value_normalized]),
      );
    this.audit.record({
      actorType: 'user',
      actionType: 'suppression.added',
      objectType: 'suppression',
      objectId: row.id,
      payload: { kind, reason },
      correlationId: ctx.correlationId,
    });
    return { row: toDto(row), created: true };
  }
}

export function detectKind(value: string): SuppressionKind {
  if (/linkedin\.com\//i.test(value)) return 'profile_url';
  if (/^https?:\/\//i.test(value)) {
    // A bare site (`https://acme.com/`) means the domain; a path or query means a profile page.
    try {
      const url = new URL(value);
      return url.pathname.replace(/\/+$/, '') === '' && !url.search ? 'domain' : 'profile_url';
    } catch {
      return 'profile_url';
    }
  }
  if (value.includes('@')) return 'email';
  return 'domain';
}
