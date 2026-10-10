import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@tabreach/protocol';
import { AuditLog } from '../audit/audit-log.js';
import { ctx, testServices } from '../prospects/test-helpers.js';
import { SettingsRepository } from '../settings/settings.js';
import { SetupService } from './setup-service.js';

describe('first-run setup (FR-APP-002)', () => {
  let env: Awaited<ReturnType<typeof testServices>>;
  let aiKey = false;
  let chrome: { installed: boolean; version: string | null; path: string | null } | null = null;
  let setup: SetupService;
  const ts = () => new Date().toISOString();

  beforeEach(async () => {
    env = await testServices();
    aiKey = false;
    chrome = null;
    setup = new SetupService({
      db: env.db,
      settings: new SettingsRepository(env.db),
      audit: new AuditLog(env.db),
      now: () => new Date('2026-10-10T10:00:00.000Z'),
      aiKeySet: () => aiKey,
      chrome: () => Promise.resolve(chrome),
    });
  });
  afterEach(() => env.close());

  it('a fresh install has nothing configured and the wizard not finished', async () => {
    expect(await setup.state()).toEqual({
      chrome: null,
      aiKeySet: false,
      emailAccounts: 0,
      profiles: 0,
      completedAt: null,
    });
  });

  it('reports what is configured: Chrome, the key, active email accounts, profiles not archived', async () => {
    aiKey = true;
    chrome = { installed: true, version: '154.0.0.0', path: '/Applications/Google Chrome.app' };
    const account = (channel: string, provider: string, status: string) =>
      env.db
        .prepare(
          `INSERT INTO channel_accounts (id, channel, provider, display_name, external_account_id, limits, status,
                                         created_at, updated_at)
           VALUES (?, ?, ?, 'x', ?, '{}', ?, ?, ?)`,
        )
        .run(uuidv7(), channel, provider, uuidv7(), status, ts(), ts());
    account('email', 'imap_smtp', 'active');
    account('email', 'gmail_api', 'disabled');
    account('linkedin', 'linkedin_browser', 'active');
    await env.services.browser.create({ name: 'Work', purpose: 'general' }, ctx());
    expect(await setup.state()).toMatchObject({
      chrome: { installed: true },
      aiKeySet: true,
      emailAccounts: 1,
      profiles: 1,
    });
  });

  it('finishing is remembered once and audited', async () => {
    const first = await setup.complete(ctx());
    expect(first.completedAt).toBe('2026-10-10T10:00:00.000Z');
    expect((await setup.complete(ctx())).completedAt).toBe(first.completedAt);
    expect(
      env.db.prepare(`SELECT COUNT(*) AS n FROM action_events WHERE action_type = 'setup.completed'`).get(),
    ).toEqual({ n: 1 });
  });
});
