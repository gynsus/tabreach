import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
import { transaction } from './database.js';
import type { Migration } from './migrations.js';

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  applied: number[];
  /** Local recovery backup taken before applying migrations to a non-empty database. */
  backupPath: string | null;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function currentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as
    { v: number } | undefined;
  return row?.v ?? 0;
}

/**
 * Applies pending migrations in order, each in its own transaction.
 *
 * Before touching a database that already has a schema, it writes a local recovery backup
 * through the SQLite online backup API (never a plain file copy of a WAL database).
 */
export async function migrate(
  db: DatabaseSync,
  all: readonly Migration[],
  opts: {
    backupDir: string;
    now?: () => Date;
    /** For a copy that is itself a backup being restored: nothing to roll back to. */
    skipBackup?: boolean;
  },
): Promise<MigrationReport> {
  assertOrdered(all);
  ensureMigrationsTable(db);

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedRow[];
  const known = new Map(all.map((m) => [m.version, m]));

  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new MigrationError(
        `Database has migration ${row.version} (${row.name}) that this app version does not know. ` +
          'The database was created by a newer TabReach; restore a matching app version or a backup.',
      );
    }
    if (checksum(migration.sql) !== row.checksum) {
      throw new MigrationError(`Applied migration ${row.version} (${row.name}) was edited after it ran.`);
    }
  }

  const fromVersion = applied.at(-1)?.version ?? 0;
  const pending = all.filter((m) => m.version > fromVersion);
  if (pending.length === 0) {
    return { fromVersion, toVersion: fromVersion, applied: [], backupPath: null };
  }

  const now = opts.now ?? (() => new Date());
  let backupPath: string | null = null;
  if (fromVersion > 0 && !opts.skipBackup) {
    mkdirSync(opts.backupDir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    backupPath = join(opts.backupDir, `pre-migration-v${fromVersion}-${stamp}.db`);
    await backup(db, backupPath);
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );
  for (const migration of pending) {
    // PRAGMA foreign_keys only takes effect outside a transaction. Table rebuilds (the SQLite
    // 12-step procedure) need it off, or DROP TABLE would cascade-delete child rows.
    if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(migration.sql);
        migration.run?.(db);
        if (migration.foreignKeysOff) {
          const broken = db.prepare('PRAGMA foreign_key_check').all();
          if (broken.length > 0) {
            throw new MigrationError(
              `Migration ${migration.version} (${migration.name}) left ${broken.length} broken foreign keys.`,
            );
          }
        }
        insert.run(migration.version, migration.name, checksum(migration.sql), now().toISOString());
      });
    } finally {
      if (migration.foreignKeysOff) db.exec('PRAGMA foreign_keys = ON');
    }
  }

  return {
    fromVersion,
    toVersion: pending.at(-1)?.version ?? fromVersion,
    applied: pending.map((m) => m.version),
    backupPath,
  };
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
}

function assertOrdered(all: readonly Migration[]): void {
  all.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new MigrationError(
        `Migrations must be numbered 1..n without gaps; got ${m.version} at index ${i}.`,
      );
    }
  });
}
