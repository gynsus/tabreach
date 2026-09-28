import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { currentSchemaVersion, migrate, MigrationError } from './migrate.js';
import { migrations, type Migration } from './migrations.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabreach-migrate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const backupDir = () => join(dir, 'backups');
const first: Migration = { version: 1, name: 'one', sql: 'CREATE TABLE a (id TEXT PRIMARY KEY) STRICT;' };
const second: Migration = { version: 2, name: 'two', sql: 'CREATE TABLE b (id TEXT PRIMARY KEY) STRICT;' };

describe('migrate', () => {
  it('applies all real migrations to an empty database without a backup', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    const report = await migrate(db, migrations, { backupDir: backupDir() });
    expect(report).toMatchObject({ fromVersion: 0, toVersion: migrations.length, backupPath: null });
    expect(currentSchemaVersion(db)).toBe(migrations.length);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['schema_migrations', 'secrets', 'settings']),
    );
    db.close();
  });

  it('upgrades a previous-version database with data (v8 → current)', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, migrations.slice(0, 8), { backupDir: backupDir() });
    const ts = '2026-09-28T10:00:00.000Z';
    db.prepare(
      `INSERT INTO side_effects (id, idempotency_key, scope_id, step_position, channel, action_type, target_normalized,
                                 status, created_at, updated_at)
       VALUES ('se-1', 'k', 'e', 1, 'test', 'send_message', 'a@b.test', 'completed', ?, ?)`,
    ).run(ts, ts);
    const report = await migrate(db, migrations, { backupDir: backupDir() });
    expect(report).toMatchObject({ fromVersion: 8, toVersion: migrations.length });
    expect(report.backupPath).not.toBeNull();
    expect(db.prepare('SELECT status, channel_account_id FROM side_effects').all()).toEqual([
      { status: 'completed', channel_account_id: null },
    ]);
    db.close();
  });

  it('is a no-op on an up-to-date database', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, migrations, { backupDir: backupDir() });
    const again = await migrate(db, migrations, { backupDir: backupDir() });
    expect(again.applied).toEqual([]);
    db.close();
  });

  it('backs up an existing database, including its data, before migrating it', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, [first], { backupDir: backupDir() });
    db.prepare('INSERT INTO a (id) VALUES (?)').run('kept');

    const report = await migrate(db, [first, second], {
      backupDir: backupDir(),
      now: () => new Date('2026-09-28T10:00:00.000Z'),
    });
    expect(report).toMatchObject({ fromVersion: 1, toVersion: 2, applied: [2] });
    expect(report.backupPath).toBe(join(backupDir(), 'pre-migration-v1-2026-09-28T10-00-00-000Z.db'));
    expect(existsSync(report.backupPath!)).toBe(true);

    const snapshot = new DatabaseSync(report.backupPath!, { readOnly: true });
    expect(snapshot.prepare('SELECT id FROM a').all()).toEqual([{ id: 'kept' }]);
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
    snapshot.close();
    db.close();
  });

  it('refuses to run when an applied migration was edited', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, [first], { backupDir: backupDir() });
    const edited = { ...first, sql: first.sql + ' -- changed' };
    await expect(migrate(db, [edited], { backupDir: backupDir() })).rejects.toThrow(MigrationError);
    db.close();
  });

  it('refuses to run on a database created by a newer app version', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, [first, second], { backupDir: backupDir() });
    await expect(migrate(db, [first], { backupDir: backupDir() })).rejects.toThrow(/newer TabReach/);
    db.close();
  });

  it('rolls back a failing migration and leaves the version unchanged', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, [first], { backupDir: backupDir() });
    const broken: Migration = {
      version: 2,
      name: 'broken',
      sql: 'CREATE TABLE c (id TEXT); CREATE TABLE a (x TEXT);',
    };
    await expect(migrate(db, [first, broken], { backupDir: backupDir() })).rejects.toThrow();
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'c'").all()).toEqual([]);
    db.close();
  });

  it('rejects gaps in migration numbering', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await expect(migrate(db, [second], { backupDir: backupDir() })).rejects.toThrow(/without gaps/);
    db.close();
  });
});

describe('migration hooks', () => {
  it('runs the data step in the same transaction and rolls both back on failure', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, [first], { backupDir: backupDir() });
    db.prepare('INSERT INTO a (id) VALUES (?)').run('x');
    const failing: Migration = {
      version: 2,
      name: 'with data step',
      sql: 'ALTER TABLE a ADD COLUMN k TEXT;',
      run: () => {
        throw new Error('data step failed');
      },
    };
    await expect(migrate(db, [first, failing], { backupDir: backupDir() })).rejects.toThrow(
      'data step failed',
    );
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM pragma_table_info('a') WHERE name = 'k'").all()).toEqual([]);
    db.close();
  });

  it('rebuilds a parent table without cascading deletes when foreign keys are off', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    const base: Migration = {
      version: 1,
      name: 'base',
      sql: `CREATE TABLE p (id TEXT PRIMARY KEY) STRICT;
            CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT NOT NULL REFERENCES p (id) ON DELETE CASCADE) STRICT;`,
    };
    await migrate(db, [base], { backupDir: backupDir() });
    db.exec("INSERT INTO p VALUES ('p1'); INSERT INTO c VALUES ('c1', 'p1');");
    const rebuild: Migration = {
      version: 2,
      name: 'rebuild p',
      foreignKeysOff: true,
      sql: `CREATE TABLE p_new (id TEXT PRIMARY KEY, extra TEXT) STRICT;
            INSERT INTO p_new (id) SELECT id FROM p;
            DROP TABLE p;
            ALTER TABLE p_new RENAME TO p;`,
    };
    await migrate(db, [base, rebuild], { backupDir: backupDir() });
    expect(db.prepare('SELECT id FROM c').all()).toEqual([{ id: 'c1' }]);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
    db.close();
  });
});
