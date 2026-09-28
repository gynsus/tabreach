import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';
import { nameKey } from './normalize.js';

type Link = { table: 'company_tags'; column: 'company_id' } | { table: 'contact_tags'; column: 'contact_id' };
export const companyTags: Link = { table: 'company_tags', column: 'company_id' };
export const contactTags: Link = { table: 'contact_tags', column: 'contact_id' };

/** Returns tag ids, creating missing tags. Names match case-insensitively (Unicode-aware key). */
function ensureTags(db: DatabaseSync, names: readonly string[]): string[] {
  const find = db.prepare('SELECT id FROM tags WHERE name_key = ?');
  const insert = db.prepare('INSERT INTO tags (id, name, name_key) VALUES (?, ?, ?)');
  return names.flatMap((name) => {
    const key = nameKey(name);
    if (!key) return [];
    const row = find.get(key) as { id: string } | undefined;
    if (row) return [row.id];
    const id = uuidv7();
    insert.run(id, name.trim(), key);
    return [id];
  });
}

/**
 * `add` merges into existing tags (imports never remove tags); `replace` sets exactly `names`.
 * Returns true when the tag set changed.
 */
export function applyTags(
  db: DatabaseSync,
  link: Link,
  entityId: string,
  names: readonly string[],
  mode: 'add' | 'replace',
): boolean {
  const before = tagsOf(db, link, [entityId]).get(entityId) ?? [];
  if (mode === 'replace') {
    db.prepare(`DELETE FROM ${link.table} WHERE ${link.column} = ?`).run(entityId);
  }
  const insert = db.prepare(`INSERT OR IGNORE INTO ${link.table} (${link.column}, tag_id) VALUES (?, ?)`);
  for (const tagId of ensureTags(db, names)) insert.run(entityId, tagId);
  const after = tagsOf(db, link, [entityId]).get(entityId) ?? [];
  const key = (tags: string[]) => tags.map((t) => t.toLowerCase()).join('\n');
  return key(before) !== key(after);
}

export function tagsOf(db: DatabaseSync, link: Link, ids: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  // Chunk to stay well below SQLite's bound-parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = db
      .prepare(
        `SELECT l.${link.column} AS entity_id, t.name FROM ${link.table} l JOIN tags t ON t.id = l.tag_id
         WHERE l.${link.column} IN (${chunk.map(() => '?').join(',')}) ORDER BY t.name_key`,
      )
      .all(...chunk) as { entity_id: string; name: string }[];
    for (const r of rows) out.set(r.entity_id, [...(out.get(r.entity_id) ?? []), r.name]);
  }
  return out;
}
