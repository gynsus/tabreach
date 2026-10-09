import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { strFromU8, unzipSync } from 'fflate';
import { uuidv7, type HealthReport } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';
import { DiagnosticsService } from './bundle.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const SECRET = 'very-secret-ciphertext-value';
const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
const PROFILE_URL = 'https://www.linkedin.com/in/ann-lee-12345/';

describe('diagnostics bundle (docs/20, FR-BRA-007)', () => {
  let dir: string;
  let db: DatabaseSync;
  let service: DiagnosticsService;
  const shot = `${uuidv7()}.png`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tabreach-diag-'));
    db = openDatabase(join(dir, 'app.db'));
    await migrate(db, migrations, { backupDir: join(dir, 'backups') });
    mkdirSync(join(dir, 'diagnostics'));
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'diagnostics', shot), 'PNG-BYTES');
    writeFileSync(join(dir, 'outside.png'), 'NOT-OURS');
    writeFileSync(
      join(dir, 'logs', 'core.log'),
      [
        JSON.stringify({ level: 30, event: 'core.started', msg: 'core started' }),
        JSON.stringify({
          level: 40,
          event: 'ai.failed',
          apiKey: API_KEY,
          msg: `call failed with ${API_KEY}`,
        }),
        `plain line Bearer abcdefghijklmnop0123`,
      ].join('\n'),
    );

    // Fixture rows only: the reader is tested, not the workflows that write them.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO secrets (id, purpose, ciphertext, created_at, updated_at) VALUES (?, 'ai.anthropic', ?, ?, ?)`,
    ).run(uuidv7(), Buffer.from(SECRET), NOW.toISOString(), NOW.toISOString());
    db.prepare(
      `INSERT INTO browser_tasks (id, workflow_run_id, task_type, browser_profile_id, browser_session_id,
         adapter_pack_id, adapter_pack_version, status, result, dispatched_at, finished_at)
       VALUES (?, ?, 'commit', ?, ?, 'linkedin', '0.5.1', 'unsupported_state', ?, ?, ?)`,
    ).run(
      uuidv7(),
      uuidv7(),
      uuidv7(),
      uuidv7(),
      JSON.stringify({
        status: 'unsupported_state',
        stateId: 'linkedin.profile.connectable',
        errorKey: null,
        url: PROFILE_URL,
        diagnostics: {
          screenshot: shot,
          title: 'Ann Lee | LinkedIn',
          expectedStates: ['linkedin.invite.dialog'],
        },
      }),
      new Date(NOW.getTime() - 60_000).toISOString(),
      NOW.toISOString(),
    );

    service = new DiagnosticsService({
      db,
      now: () => NOW,
      logDir: join(dir, 'logs'),
      diagnosticsDir: join(dir, 'diagnostics'),
      health: () =>
        Promise.resolve({
          checkedAt: NOW.toISOString(),
          app: { version: '0.0.1', electron: '44.0.0', node: '24.0.0' },
          core: { status: 'ok' },
        } as unknown as HealthReport),
      packs: () => [{ id: 'linkedin', version: '0.5.1' }],
    });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the screenshots kept for tasks, with codes only', () => {
    expect(service.screenshots()).toEqual([
      {
        file: shot,
        takenAt: NOW.toISOString(),
        packId: 'linkedin',
        stateId: 'linkedin.profile.connectable',
        errorKey: null,
      },
    ]);
  });

  it('holds versions, redacted logs and state, and nothing secret or personal', async () => {
    const bundle = await service.createBundle({ screenshots: [] });
    const files = unzipSync(Buffer.from(bundle.base64, 'base64'));
    expect(Object.keys(files).sort()).toEqual([
      'events.json',
      'logs/core.log',
      'manifest.json',
      'state.json',
    ]);
    expect(bundle.contents).toEqual(Object.keys(files).sort());
    const all = Object.values(files)
      .map((f) => strFromU8(f))
      .join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain('abcdefghijklmnop0123');
    expect(all).not.toContain(PROFILE_URL);
    expect(all).not.toContain('Ann Lee');
    expect(all).not.toContain('PNG-BYTES'); // no screenshot unless chosen
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      app: { version: '0.0.1' },
      adapterPacks: [{ id: 'linkedin', version: '0.5.1' }],
    });
    const state = JSON.parse(strFromU8(files['state.json']!)) as { browserTasks: unknown[] };
    expect(state.browserTasks).toEqual([
      expect.objectContaining({
        adapter_pack_version: '0.5.1',
        result: expect.objectContaining({
          stateId: 'linkedin.profile.connectable',
          expectedStates: ['linkedin.invite.dialog'],
        }),
      }),
    ]);
    expect(strFromU8(files['logs/core.log']!)).toContain('core.started');
  });

  it('adds only screenshots the person chose among its own, by exact name', async () => {
    const bundle = await service.createBundle({ screenshots: [shot, `${uuidv7()}.png`, '../outside.png'] });
    const files = unzipSync(Buffer.from(bundle.base64, 'base64'));
    expect(Object.keys(files).filter((f) => f.startsWith('screenshots/'))).toEqual([`screenshots/${shot}`]);
    expect(strFromU8(files[`screenshots/${shot}`]!)).toBe('PNG-BYTES');
    expect(
      Object.values(files)
        .map((f) => strFromU8(f))
        .join('\n'),
    ).not.toContain('NOT-OURS');
  });
});
