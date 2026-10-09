import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RETENTION_DEFAULTS, uuidv7 } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClock } from '../db/test-db.js';
import { ctx, testServices } from '../prospects/test-helpers.js';

const DAY = 24 * 60 * 60_000;

describe('data retention (docs/18, Phase 8a-3)', () => {
  const clock = fakeClock('2026-10-09T12:00:00.000Z');
  let env: Awaited<ReturnType<typeof testServices>>;
  let dir: string;
  const ago = (days: number) => new Date(clock.now().getTime() - days * DAY).toISOString();
  const file = (folder: string, name: string, daysOld: number) => {
    const path = join(dir, folder, name);
    writeFileSync(path, 'x');
    const t = (clock.now().getTime() - daysOld * DAY) / 1000;
    utimesSync(path, t, t);
    return path;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tabreach-retention-'));
    mkdirSync(join(dir, 'diagnostics'));
    mkdirSync(join(dir, 'logs'));
    env = await testServices({
      now: clock.now,
      diagnosticsDir: join(dir, 'diagnostics'),
      logDir: join(dir, 'logs'),
    });
    // Fixture rows only: the pruning is tested, not the workflows that write them.
    env.db.exec('PRAGMA foreign_keys = OFF');
  });
  afterEach(() => {
    env.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (status: string) => {
    const id = uuidv7();
    env.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_type, definition_version, business_type, business_id, status,
                                    current_state, context, correlation_id, created_at, updated_at)
         VALUES (?, 'campaign_message', 1, 'enrollment', ?, ?, 'SEND', '{}', ?, ?, ?)`,
      )
      .run(id, uuidv7(), status, uuidv7(), ago(100), ago(100));
    return id;
  };
  const enrollment = (status: string) => {
    const id = uuidv7();
    env.db
      .prepare(
        `INSERT INTO campaign_enrollments (id, campaign_id, campaign_version_id, contact_id, status,
                                           current_step_position, lock_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      )
      .run(id, uuidv7(), uuidv7(), uuidv7(), status, ago(100), ago(100));
    return id;
  };
  const draft = (runId: string, enrollmentId: string | null, daysOld: number) => {
    const id = uuidv7();
    env.db
      .prepare(
        `INSERT INTO message_drafts (id, contact_id, campaign_enrollment_id, workflow_run_id, channel, subject,
                                     body, content_hash, version, created_at)
         VALUES (?, ?, ?, ?, 'email', 'Hello Ann', 'Dear Ann, about your launch', 'h', 1, ?)`,
      )
      .run(id, uuidv7(), enrollmentId, runId, ago(daysOld));
    return id;
  };
  const body = (id: string) =>
    (env.db.prepare('SELECT body FROM message_drafts WHERE id = ?').get(id) as { body: string }).body;

  it('keeps everything that is newer than its limit, and message texts by default', async () => {
    const d = draft(run('completed'), enrollment('completed'), 400);
    const shot = file('diagnostics', `${uuidv7()}.png`, 10);
    const report = await env.services.retention.prune();
    expect(report).toMatchObject({ screenshots: 0, messageBodies: 0, researchEvidence: 0, logs: 0 });
    expect(body(d)).toBe('Dear Ann, about your launch');
    expect(existsSync(shot)).toBe(true);
    expect(env.services.retention.settings()).toEqual(RETENTION_DEFAULTS);
  });

  it('removes old screenshots, page details, evidence text and rotated logs; never the current log', async () => {
    const oldShot = file('diagnostics', `${uuidv7()}.png`, 31);
    const newShot = file('diagnostics', `${uuidv7()}.png`, 5);
    const oldLog = file('logs', 'core.1.log', 31);
    const current = file('logs', 'core.log', 90);
    env.db
      .prepare(
        `INSERT INTO browser_tasks (id, workflow_run_id, task_type, browser_profile_id, browser_session_id,
           adapter_pack_id, adapter_pack_version, status, result, dispatched_at)
         VALUES (?, ?, 'commit', ?, ?, 'linkedin', '0.5.1', 'unsupported_state', ?, ?)`,
      )
      .run(
        uuidv7(),
        uuidv7(),
        uuidv7(),
        uuidv7(),
        JSON.stringify({
          status: 'unsupported_state',
          stateId: 'linkedin.profile.connectable',
          url: 'https://www.linkedin.com/in/ann-lee/',
          diagnostics: {
            title: 'Ann Lee | LinkedIn',
            url: 'x',
            screenshot: 'a.png',
            ariaSnapshot: '- heading "Ann"',
            expectedStates: [],
          },
        }),
        ago(40),
      );
    env.db
      .prepare(
        `INSERT INTO evidence (id, url, title, content_hash, text, extractor, captured_at)
         VALUES (?, 'https://acme.test/', 'Acme', 'hash-1', 'Acme launched a product in May.', 'readability', ?)`,
      )
      .run(uuidv7(), ago(200));

    const report = await env.services.retention.prune();
    expect(report).toMatchObject({ screenshots: 1, browserDiagnostics: 1, researchEvidence: 1, logs: 1 });
    expect([existsSync(oldShot), existsSync(newShot), existsSync(oldLog), existsSync(current)]).toEqual([
      false,
      true,
      false,
      true,
    ]);
    const task = JSON.parse(
      (env.db.prepare('SELECT result FROM browser_tasks').get() as { result: string }).result,
    ) as Record<string, unknown>;
    expect(task).toMatchObject({
      stateId: 'linkedin.profile.connectable',
      url: null,
      diagnostics: { title: null, url: null, ariaSnapshot: '', screenshot: 'a.png' },
    });
    expect(env.db.prepare('SELECT text FROM evidence').get()).toEqual({ text: '' });
    expect(env.services.retention.lastRun()).toEqual(report);
    expect(
      env.db.prepare(`SELECT COUNT(*) AS n FROM action_events WHERE action_type = 'retention.pruned'`).get(),
    ).toEqual({ n: 1 });
  });

  it('blanks message texts only once the step and the sequence are over', async () => {
    env.services.retention.update({ ...RETENTION_DEFAULTS, messageBodies: 90 }, ctx());
    const over = draft(run('completed'), enrollment('completed'), 100);
    const stillGoing = draft(run('completed'), enrollment('active'), 100); // context for the next step
    const inFlight = draft(run('waiting_approval'), enrollment('active'), 100);
    const recent = draft(run('completed'), enrollment('completed'), 10);
    const report = await env.services.retention.prune();
    expect(report.messageBodies).toBe(1);
    expect([body(over), body(stillGoing), body(inFlight), body(recent)]).toEqual([
      '',
      'Dear Ann, about your launch',
      'Dear Ann, about your launch',
      'Dear Ann, about your launch',
    ]);
    // The hash that guards the send stays.
    expect(env.db.prepare('SELECT content_hash FROM message_drafts WHERE id = ?').get(over)).toEqual({
      content_hash: 'h',
    });
  });

  it('a limit set to "keep" removes nothing of that kind', async () => {
    env.services.retention.update({ ...RETENTION_DEFAULTS, screenshots: null }, ctx());
    const shot = file('diagnostics', `${uuidv7()}.png`, 400);
    expect((await env.services.retention.prune()).screenshots).toBe(0);
    expect(existsSync(shot)).toBe(true);
  });
});
