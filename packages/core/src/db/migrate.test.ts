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
