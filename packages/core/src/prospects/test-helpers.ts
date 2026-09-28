import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';
import { AppServices } from '../app-handlers.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';

/** A migrated database in a temp dir plus the app services over it. Call `close()` in afterEach. */
export async function testServices(): Promise<{ db: DatabaseSync; services: AppServices; close(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'tabreach-prospects-'));
  const db = openDatabase(join(dir, 'app.db'));
  await migrate(db, migrations, { backupDir: join(dir, 'backups') });
  return {
    db,
    services: new AppServices(db),
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const ctx = () => ({ correlationId: uuidv7() });
