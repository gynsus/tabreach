import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appControlSchema, uuidv7, type Logger } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AuditLog } from '../audit/audit-log.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';
import { SettingsRepository } from '../settings/settings.js';
import {
  applyPendingRestore,
  BackupService,
  inspectBackup,
  pruneAutomaticBackups,
} from './backup-service.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => logger } as unknown as Logger;
const ctx = () => ({ correlationId: uuidv7() });
const CIPHERTEXT = 'CIPHERTEXT-MARKER-0f3a9c';
const probe = z.object({ n: z.number() });

describe('local recovery backups and the portable export (FR-APP-005, ADR 029)', () => {
  let root: string;
  let dataDir: string;
  let db: DatabaseSync;
  let service: BackupService;
  let paused: number;
  let restart: ReturnType<typeof vi.fn<() => void>>;
  let savePath: string | null;
  const now = () => new Date();

  const open = async () => {
    db = openDatabase(join(dataDir, 'app.db'));
    await migrate(db, migrations, { backupDir: join(dataDir, 'backups') });
    const settings = new SettingsRepository(db, now);
    service = new BackupService({
      db,
      now,
      dataDir,
      migrations,
      audit: new AuditLog(db, now),
      settings,
      pauseAll: () => {
        paused++;
        settings.set('app.control', {
          paused: true,
          pausedAt: now().toISOString(),
          emergencyStoppedAt: null,
          keepAwake: false,
        });
      },
      chooseSavePath: () => Promise.resolve(savePath),
      restart,
      logger,
    });
  };
  const setProbe = (n: number) => new SettingsRepository(db, now).set('probe', { n });
  const readProbe = (d: DatabaseSync) => new SettingsRepository(d, now).get('probe', probe)?.n ?? null;
  const ts = () => now().toISOString();

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tabreach-backup-'));
    dataDir = join(root, 'data');
    paused = 0;
    restart = vi.fn<() => void>();
    savePath = join(root, 'export.db');
    mkdirSync(dataDir);
    await open();
    db.prepare(
      `INSERT INTO secrets (id, purpose, ciphertext, created_at, updated_at) VALUES ('s1', 'ai_api_key', ?, ?, ?)`,
    ).run(Buffer.from(CIPHERTEXT), ts(), ts());
  });
  afterEach(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a manual backup is a full copy, private to this user, listed with its schema version', async () => {
    const created = await service.create(ctx());
    expect(created).toMatchObject({ kind: 'manual', schemaVersion: migrations.length });
    const path = join(dataDir, 'backups', created.name);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(service.list().map((b) => b.name)).toEqual([created.name]);
    const copy = new DatabaseSync(path, { readOnly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 1 });
    copy.close();
    expect(inspectBackup(path, migrations)).toBe(migrations.length);
  });

  it('restores: the data rolls back, credentials stay, sends and opt-outs since then are kept, the app starts paused', async () => {
    setProbe(1);
    const { name } = await service.create(ctx());
    // After the backup: data changes, an email goes out, someone opts out.
    setProbe(2);
    db.prepare(
      `INSERT INTO side_effects (id, idempotency_key, scope_id, step_position, channel, action_type, target_normalized,
                                 status, created_at, updated_at)
       VALUES ('se-1', 'enrollment-1:1', 'enrollment-1', 1, 'email', 'send_message', 'ann@acme.test', 'completed', ?, ?)`,
    ).run(ts(), ts());
    db.prepare(
      `INSERT INTO suppressions (id, kind, value_original, value_normalized, reason, created_at)
       VALUES ('sup-1', 'email', 'bob@acme.test', 'bob@acme.test', 'opt_out', ?)`,
    ).run(ts());

    vi.useFakeTimers();
    try {
      expect(service.restore(name, ctx())).toEqual({ restarting: true });
      vi.advanceTimersByTime(400);
    } finally {
      vi.useRealTimers();
    }
    expect(paused).toBe(1);
    expect(restart).toHaveBeenCalledOnce();
    db.close();

    const outcome = await applyPendingRestore({ dataDir, migrations, now, logger });
    expect(outcome).toMatchObject({ name, ok: true });
    expect(existsSync(join(dataDir, 'restore-pending.json'))).toBe(false);

    await open();
    expect(readProbe(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT status FROM side_effects WHERE id = ?').get('se-1')).toEqual({
      status: 'completed',
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM suppressions').get()).toEqual({ n: 1 });
    expect(new SettingsRepository(db, now).get('app.control', appControlSchema)?.paused).toBe(true);
    expect(service.lastRestore()).toMatchObject({ name, ok: true });
    expect(
      db.prepare(`SELECT status FROM action_events WHERE action_type = 'backup.restored'`).all(),
    ).toEqual([{ status: 'completed' }]);

    // What was replaced is itself a backup, and can be restored again.
    const pre = service.list().find((b) => b.kind === 'pre_restore');
    expect(pre?.name).toBe(outcome?.preRestore);
    const before = new DatabaseSync(join(dataDir, 'backups', pre!.name), { readOnly: true });
    expect(readProbe(before)).toBe(2);
    before.close();
  });

  it('refuses what it cannot restore, before restarting anything', async () => {
    expect(() => service.restore('manual-nope.db', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'backup.notFound' }) }),
    );
    expect(() => service.restore('../app.db', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ code: 'NOT_FOUND' }) }),
    );

    mkdirSync(join(dataDir, 'backups'), { recursive: true });
    writeFileSync(join(dataDir, 'backups', 'manual-garbage.db'), 'not a database at all, just text');
    expect(() => service.restore('manual-garbage.db', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'backup.unreadable' }) }),
    );

    const { name } = await service.create(ctx());
    const newer = new DatabaseSync(join(dataDir, 'backups', name));
    newer.prepare(`INSERT INTO schema_migrations VALUES (9999, 'future', 'x', ?)`).run(ts());
    newer.close();
    expect(() => service.restore(name, ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'backup.newerApp' }) }),
    );

    expect(paused).toBe(0);
    expect(restart).not.toHaveBeenCalled();
  });

  it('a restore that fails at start keeps the current database and says so, once', async () => {
    setProbe(1);
    const { name } = await service.create(ctx());
    setProbe(2);
    vi.useFakeTimers();
    try {
      service.restore(name, ctx());
    } finally {
      vi.useRealTimers();
    }
    db.close();
    // The file is damaged between the request and the restart.
    writeFileSync(join(dataDir, 'backups', name), 'damaged');

    const outcome = await applyPendingRestore({ dataDir, migrations, now, logger });
    expect(outcome).toMatchObject({ name, ok: false, preRestore: null });
    expect(await applyPendingRestore({ dataDir, migrations, now, logger })).toBeNull();
    expect(existsSync(join(dataDir, 'app.db.restoring'))).toBe(false);
    await open();
    expect(readProbe(db)).toBe(2);
    expect(service.lastRestore()).toMatchObject({ ok: false });
  });

  it('the portable export has no secrets — not even in freed pages — and cannot be restored', async () => {
    const account = uuidv7();
    db.prepare(
      `INSERT INTO channel_accounts (id, channel, provider, display_name, external_account_id, secret_id, limits,
                                     status, created_at, updated_at)
       VALUES (?, 'email', 'imap_smtp', 'Work', 'me@acme.test', 's1', '{}', 'active', ?, ?)`,
    ).run(account, ts(), ts());
    setProbe(7);

    expect(await service.exportPortable(ctx())).toMatchObject({ saved: true });
    const raw = readFileSync(savePath!);
    expect(raw.includes(Buffer.from(CIPHERTEXT))).toBe(false);
    expect(statSync(savePath!).mode & 0o777).toBe(0o600);
    const copy = new DatabaseSync(savePath!, { readOnly: true });
    const tables = (
      copy.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).not.toContain('secrets');
    expect(tables).not.toContain('command_log');
    expect(copy.prepare('SELECT secret_id FROM channel_accounts').get()).toEqual({ secret_id: null });
    expect(readProbe(copy)).toBe(7);
    copy.close();
    expect(() => inspectBackup(savePath!, migrations)).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'backup.isExport' }) }),
    );
    expect(readdirNames(dataDir).filter((n) => n.startsWith('export-'))).toEqual([]);

    savePath = null;
    expect(await service.exportPortable(ctx())).toEqual({ saved: false });
  });

  it('keeps the newest ten automatic backups and every manual one', () => {
    const dir = join(dataDir, 'backups');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 13; i++) {
      const f = join(dir, `pre-migration-v${i}-x${i}.db`);
      writeFileSync(f, '');
      utimesSync(f, 1_000_000 + i, 1_000_000 + i);
    }
    writeFileSync(join(dir, 'manual-old.db'), '');
    utimesSync(join(dir, 'manual-old.db'), 1, 1);
    expect(pruneAutomaticBackups(dir)).toBe(3);
    const left = readdirNames(dir);
    expect(left).toContain('manual-old.db');
    expect(left).not.toContain('pre-migration-v0-x0.db');
    expect(left).toContain('pre-migration-v12-x12.db');
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir);
}
