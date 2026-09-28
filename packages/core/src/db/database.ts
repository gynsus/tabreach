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

const depth = new WeakMap<DatabaseSync, number>();

/**
 * Runs `fn` atomically. The outermost call uses BEGIN IMMEDIATE / COMMIT; nested calls become
 * SAVEPOINTs, so services compose (a job enqueued inside a state change commits or rolls back with
 * it) and a caller can roll back one step (one CSV row) while keeping the rest.
 *
 * `fn` must be synchronous: node:sqlite is synchronous, and awaiting inside a transaction would
 * commit before the awaited work ran.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  const savepoint = `sp_${level}`;
  db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  depth.set(db, level + 1);
  let result: T;
  try {
    result = fn();
    if (result instanceof Promise) {
      throw new TypeError('transaction() callback must be synchronous; it returned a Promise');
    }
  } catch (error) {
    depth.set(db, level);
    try {
      db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    } catch (rollbackError) {
      // Keep the original failure visible; the rollback failure is secondary.
      throw new AggregateError([error, rollbackError], 'Transaction failed and rollback failed', {
        cause: rollbackError,
      });
    }
    throw error;
  }
  depth.set(db, level);
  db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
  return result;
}
