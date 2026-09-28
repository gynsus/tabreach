import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.js';
import { migrate } from './migrate.js';
import { migrations } from './migrations.js';

/** A migrated database in a temp dir. Call `close()` in afterEach. */
export async function testDatabase(): Promise<{ db: DatabaseSync; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'tabreach-test-'));
  const db = openDatabase(join(dir, 'app.db'));
  await migrate(db, migrations, { backupDir: join(dir, 'backups') });
  return {
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A clock tests move by hand. */
export function fakeClock(start = '2026-09-28T09:00:00.000Z'): {
  now: () => Date;
  advance(ms: number): void;
  set(iso: string): void;
} {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(iso) {
      t = new Date(iso).getTime();
    },
  };
}
