import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  appControlSchema,
  backupNameSchema,
  lastRestoreSchema,
  uuidv7,
  type Backup,
  type BackupKind,
  type LastRestore,
  type Logger,
  type PortableExportResult,
} from '@tabreach/protocol';
import { AuditLog } from '../audit/audit-log.js';
import { openDatabase, transaction } from '../db/database.js';
import { checksum, migrate } from '../db/migrate.js';
import type { Migration } from '../db/migrations.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import { SettingsRepository } from '../settings/settings.js';

const MARKER = 'restore-pending.json';
const LAST_RESTORE_KEY = 'backup.lastRestore';
/** Automatic backups (before a migration, before a restore) kept; manual ones stay until deleted. */
const KEEP_AUTOMATIC = 10;

const KIND_BY_PREFIX: Record<string, BackupKind> = {
  manual: 'manual',
  'pre-migration': 'pre_migration',
  'pre-restore': 'pre_restore',
};

/**
 * Local recovery backups and the portable export (docs/03 "Two kinds of backup", FR-APP-005,
 * ADR 029). A backup is a full copy through the SQLite backup API in `data/backups/` (secrets as
 * `safeStorage` ciphertext, readable on this Mac user only). Restoring is checked here and applied
 * by `applyPendingRestore` when core restarts, before the database is opened. The portable export
 * has no secrets table and cannot be restored.
 */
export class BackupService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      /** The `data` folder holding `app.db` and `backups/`. */
      dataDir: string;
      migrations: readonly Migration[];
      audit: AuditLog;
      settings: SettingsRepository;
      pauseAll: (ctx: CommandContext) => void;
      /** Main's save dialog; the chosen path or null. */
      chooseSavePath: (suggestedName: string) => Promise<string | null>;
      /** Closes the database and restarts core, which applies the pending restore. */
      restart: () => void;
      logger: Logger;
    },
  ) {}

  private get dir(): string {
    return join(this.d.dataDir, 'backups');
  }

  list(): Backup[] {
    return listBackups(this.dir);
  }

  lastRestore(): LastRestore | null {
    return this.d.settings.get(LAST_RESTORE_KEY, lastRestoreSchema) ?? null;
  }

  schemaVersion(): number {
    return this.d.migrations.length;
  }

  async create(ctx: CommandContext): Promise<Backup> {
    const name = `manual-${stamp(this.d.now())}.db`;
    const path = join(this.dir, name);
    await backupTo(this.d.db, path);
    this.d.audit.record({
      actorType: 'user',
      actionType: 'backup.created',
      objectType: 'backup',
      objectId: name,
      payload: { bytes: statSync(path).size },
      correlationId: ctx.correlationId,
    });
    this.d.logger.info({ event: 'backup.created', correlationId: ctx.correlationId }, 'backup created');
    const created = this.list().find((b) => b.name === name);
    if (!created) throw new RpcError('INTERNAL', 'Backup was not written');
    return created;
  }

  delete(name: string, ctx: CommandContext): void {
    rmSync(this.existing(name));
    this.d.audit.record({
      actorType: 'user',
      actionType: 'backup.deleted',
      objectType: 'backup',
      objectId: name,
      correlationId: ctx.correlationId,
    });
  }

  /**
   * Checks the backup now (so a refusal is shown, not discovered at the next start), pauses
   * everything, and restarts core onto it.
   */
  restore(name: string, ctx: CommandContext): { restarting: true } {
    const path = this.existing(name);
    inspectBackup(path, this.d.migrations);
    this.d.pauseAll(ctx);
    writeFileSync(join(this.d.dataDir, MARKER), JSON.stringify({ name, correlationId: ctx.correlationId }), {
      mode: 0o600,
    });
    this.d.audit.record({
      actorType: 'user',
      actionType: 'backup.restored',
      objectType: 'backup',
      objectId: name,
      status: 'started',
      correlationId: ctx.correlationId,
    });
    this.d.logger.info({ event: 'backup.restore_requested', correlationId: ctx.correlationId }, 'restarting');
    // Answer the request first; the window then sees core restart.
    setTimeout(() => this.d.restart(), 300);
    return { restarting: true };
  }

  /**
   * A copy of the database without the `secrets` table (and without the command log), written
   * where the person chose. Freed pages are wiped, so no ciphertext survives in the file.
   */
  async exportPortable(ctx: CommandContext): Promise<PortableExportResult> {
    const date = this.d.now().toISOString().slice(0, 10);
    const target = await this.d.chooseSavePath(`TabReach export ${date}.db`);
    if (!target) return { saved: false };
    const temp = join(this.d.dataDir, `export-${uuidv7()}.tmp`);
    try {
      this.d.db.prepare('VACUUM INTO ?').run(temp);
      const copy = new DatabaseSync(temp);
      try {
        stripSecrets(copy, this.d.now());
      } finally {
        copy.close();
      }
      await copyFile(temp, target);
      chmodSync(target, 0o600);
    } finally {
      await rm(temp, { force: true });
    }
    const bytes = statSync(target).size;
    this.d.audit.record({
      actorType: 'user',
      actionType: 'backup.exported',
      objectType: 'export',
      payload: { bytes },
      correlationId: ctx.correlationId,
    });
    this.d.logger.info({ event: 'backup.exported', bytes, correlationId: ctx.correlationId }, 'export saved');
    return { saved: true, bytes };
  }

  private existing(name: string): string {
    const parsed = backupNameSchema.safeParse(name);
    const path = parsed.success ? join(this.dir, parsed.data) : null;
    if (!path || !existsSync(path)) throw new RpcError('NOT_FOUND', 'No such backup', 'backup.notFound');
    return path;
  }
}

/** Removes what must never leave this Mac from an export copy. */
export function stripSecrets(copy: DatabaseSync, now: Date): void {
  copy.exec('PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA journal_mode = DELETE;');
  transaction(copy, () => {
    copy.exec(`
      UPDATE channel_accounts SET secret_id = NULL;
      DROP TABLE secrets;
      DROP TABLE command_log;
    `);
    new SettingsRepository(copy, () => now).set('export.portable', {
      createdAt: now.toISOString(),
      secrets: 'none',
    });
  });
  copy.exec('VACUUM');
}

/** Backups in `dir`, newest first. */
export function listBackups(dir: string): Backup[] {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names
    .flatMap((name): Backup[] => {
      if (!backupNameSchema.safeParse(name).success) return [];
      const prefix = Object.keys(KIND_BY_PREFIX).find((p) => name.startsWith(`${p}-`));
      const kind = prefix ? KIND_BY_PREFIX[prefix] : undefined;
      if (!kind) return [];
      const info = statSync(join(dir, name));
      return [
        {
          name,
          kind,
          createdAt: info.mtime.toISOString(),
          bytes: info.size,
          schemaVersion: readSchemaVersion(join(dir, name)),
        },
      ];
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keeps the newest automatic backups; manual ones are the person's to delete. */
export function pruneAutomaticBackups(dir: string, keep = KEEP_AUTOMATIC): number {
  const automatic = listBackups(dir).filter((b) => b.kind !== 'manual');
  for (const old of automatic.slice(keep)) rmSync(join(dir, old.name), { force: true });
  return Math.max(0, automatic.length - keep);
}

function readSchemaVersion(path: string): number | null {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get() as
        { v: number } | undefined;
      return row?.v ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null; // not a database, or not one of ours: listed, never restorable
  }
}

/**
 * Throws a keyed error unless `path` is an intact TabReach database this app version can open:
 * every migration in it known and unedited, and a `secrets` table (a portable export has none).
 */
export function inspectBackup(path: string, known: readonly Migration[]): number {
  const unreadable = () => new RpcError('CONFLICT', 'Backup cannot be read', 'backup.unreadable');
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw unreadable();
  }
  try {
    const check = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
    if (check?.quick_check !== 'ok') throw unreadable();
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    if (!tables.has('schema_migrations')) throw unreadable();
    if (!tables.has('secrets'))
      throw new RpcError('CONFLICT', 'A portable export cannot be restored', 'backup.isExport');
    const rows = db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as {
      version: number;
      checksum: string;
    }[];
    const byVersion = new Map(known.map((m) => [m.version, m]));
    for (const row of rows) {
      const migration = byVersion.get(row.version);
      if (!migration) throw new RpcError('CONFLICT', 'Backup is from a newer TabReach', 'backup.newerApp');
      if (checksum(migration.sql) !== row.checksum) throw unreadable();
    }
    return rows.at(-1)?.version ?? 0;
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw unreadable();
  } finally {
    db.close();
  }
}

/** Tables copied from the database being replaced: the outside world does not roll back. */
const LEDGER_TABLES = ['side_effects', 'test_channel_deliveries'] as const;

/**
 * Applies a restore requested before this start (core startup, before the database is opened).
 * The current database is backed up first (`pre-restore-…`); then the chosen backup is copied,
 * migrated to this app's schema and given what must survive any rollback — the send ledger
 * (what was sent stays sent, so nothing goes out twice) and the do-not-contact list — and the app
 * starts paused. On any failure the current database stays as it was. Returns what happened, or
 * null when no restore was pending.
 */
export async function applyPendingRestore(opts: {
  dataDir: string;
  migrations: readonly Migration[];
  now: () => Date;
  logger: Logger;
}): Promise<LastRestore | null> {
  const markerPath = join(opts.dataDir, MARKER);
  if (!existsSync(markerPath)) return null;
  let request: { name: string; correlationId: string };
  try {
    request = JSON.parse(readFileSync(markerPath, 'utf8')) as typeof request;
  } finally {
    // Whatever happens next, a restore is attempted once: never a loop of failing starts.
    rmSync(markerPath, { force: true });
  }
  const at = opts.now().toISOString();
  const name = backupNameSchema.safeParse(request.name).success ? request.name : null;
  const dir = join(opts.dataDir, 'backups');
  const appDb = join(opts.dataDir, 'app.db');
  const temp = join(opts.dataDir, 'app.db.restoring');
  const removeTemp = () => {
    for (const f of [temp, `${temp}-wal`, `${temp}-shm`, `${temp}-journal`]) rmSync(f, { force: true });
  };
  removeTemp();

  try {
    if (!name) throw new Error('invalid backup name');
    const source = join(dir, name);
    inspectBackup(source, opts.migrations);
    const preRestore = `pre-restore-${stamp(opts.now())}.db`;
    const current = openDatabase(appDb);
    try {
      await backupTo(current, join(dir, preRestore));
      const src = new DatabaseSync(source, { readOnly: true });
      try {
        await backup(src, temp);
      } finally {
        src.close();
      }
      const next = openDatabase(temp);
      try {
        await migrate(next, opts.migrations, { backupDir: dir, skipBackup: true, now: opts.now });
        carryForward(next, appDb);
        const outcome: LastRestore = { name, at, ok: true, preRestore };
        transaction(next, () => {
          const settings = new SettingsRepository(next, opts.now);
          const control = settings.get('app.control', appControlSchema);
          settings.set('app.control', {
            keepAwake: false,
            emergencyStoppedAt: null,
            ...control,
            paused: true,
            pausedAt: at,
          });
          settings.set(LAST_RESTORE_KEY, outcome);
          new AuditLog(next, opts.now).record({
            actorType: 'user',
            actionType: 'backup.restored',
            objectType: 'backup',
            objectId: name,
            status: 'completed',
            payload: { preRestore },
            correlationId: request.correlationId,
          });
        });
        next.exec('PRAGMA journal_mode = DELETE');
      } finally {
        next.close();
      }
      current.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      current.close();
    }
    for (const f of [`${appDb}-wal`, `${appDb}-shm`]) rmSync(f, { force: true });
    renameSync(temp, appDb);
    pruneAutomaticBackups(dir);
    opts.logger.info({ event: 'backup.restored', correlationId: request.correlationId }, 'backup restored');
    return { name, at, ok: true, preRestore };
  } catch (error) {
    removeTemp();
    opts.logger.error(
      { event: 'backup.restore_failed', correlationId: request.correlationId, err: error },
      'restore failed; the current database was kept',
    );
    const outcome: LastRestore = { name: name ?? 'manual-invalid.db', at, ok: false, preRestore: null };
    const current = openDatabase(appDb);
    try {
      new SettingsRepository(current, opts.now).set(LAST_RESTORE_KEY, outcome);
    } finally {
      current.close();
    }
    return outcome;
  }
}

/** Copies the send ledger and the do-not-contact list from the database being replaced. */
function carryForward(next: DatabaseSync, currentPath: string): void {
  next.prepare('ATTACH DATABASE ? AS cur').run(currentPath);
  try {
    transaction(next, () => {
      for (const table of LEDGER_TABLES) {
        const cols = columns(next, table);
        next.exec(`DELETE FROM main.${table}`);
        next.exec(`INSERT INTO main.${table} (${cols}) SELECT ${cols} FROM cur.${table}`);
      }
      const cols = columns(next, 'suppressions');
      next.exec(`INSERT OR IGNORE INTO main.suppressions (${cols}) SELECT ${cols} FROM cur.suppressions`);
    });
  } finally {
    next.exec('DETACH DATABASE cur');
  }
}

function columns(db: DatabaseSync, table: string): string {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?, 'main')`).all(table) as { name: string }[];
  return rows.map((r) => `"${r.name}"`).join(', ');
}

async function backupTo(db: DatabaseSync, path: string): Promise<void> {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  await backup(db, path);
  chmodSync(path, 0o600);
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-');
}
