import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { transaction } from './database.js';

let db: DatabaseSync;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (v TEXT NOT NULL) STRICT');
});
const values = () => (db.prepare('SELECT v FROM t ORDER BY rowid').all() as { v: string }[]).map((r) => r.v);
const insert = (v: string) => db.prepare('INSERT INTO t (v) VALUES (?)').run(v);

describe('transaction', () => {
  it('commits and returns the result', () => {
    expect(transaction(db, () => (insert('a'), 42))).toBe(42);
    expect(values()).toEqual(['a']);
  });

  it('rolls back everything on failure', () => {
    expect(() =>
      transaction(db, () => {
        insert('a');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(values()).toEqual([]);
  });

  it('nests with savepoints: an inner failure rolls back only the inner work', () => {
    transaction(db, () => {
      insert('outer');
      expect(() =>
        transaction(db, () => {
          insert('inner');
          throw new Error('inner failed');
        }),
      ).toThrow('inner failed');
      transaction(db, () => insert('inner ok'));
    });
    expect(values()).toEqual(['outer', 'inner ok']);
  });

  it('an outer failure rolls back committed inner savepoints too', () => {
    expect(() =>
      transaction(db, () => {
        transaction(db, () => insert('inner'));
        throw new Error('outer failed');
      }),
    ).toThrow('outer failed');
    expect(values()).toEqual([]);
  });

  it('rejects async callbacks instead of committing early', () => {
    expect(() => transaction(db, async () => insert('a'))).toThrow(/synchronous/);
    expect(values()).toEqual([]);
    // Still usable afterwards.
    transaction(db, () => insert('b'));
    expect(values()).toEqual(['b']);
  });
});
