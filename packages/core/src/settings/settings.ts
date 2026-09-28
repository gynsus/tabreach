import type { DatabaseSync } from 'node:sqlite';
import type { z } from 'zod';

/** Key/value application settings stored as validated JSON (docs/05-DATABASE-SCHEMA.md). */
export class SettingsRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get<S extends z.ZodType>(key: string, schema: S): z.output<S> | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return undefined;
    return schema.parse(JSON.parse(row.value));
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now().toISOString());
  }
}
