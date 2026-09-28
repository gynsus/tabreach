import { DatabaseSync } from 'node:sqlite';

/**
 * Opens the application database with the pragmas required by docs/05-DATABASE-SCHEMA.md.
 * Core is the only process that opens this file (ADR 011).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  return db;
}

export function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | undefined;
  if (!row) throw new Error('sqlite_version() returned no row');
  return row.v;
}

/** Runs `fn` inside BEGIN IMMEDIATE / COMMIT, rolling back on any error. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
