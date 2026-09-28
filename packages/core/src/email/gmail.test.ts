import type { CampaignConfig } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SENT_INDEX_GRACE_MS } from './email-channel.js';
import { authorizeUrl, GMAIL_SCOPES, pkce } from './gmail.js';
import { ctx, Harness, inbound } from './harness.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';

describe('Gmail OAuth pieces', () => {
  it('builds a PKCE consent URL asking for offline access and both Gmail scopes', () => {
    const { challenge, state, verifier } = pkce();
    expect(verifier).toMatch(/^[\w-]{43}$/);
    const url = new URL(authorizeUrl(CLIENT_ID, challenge, state));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES.join(' '),
    });
    expect(url.searchParams.has('redirect_uri')).toBe(false); // main adds its loopback address
  });
});

describe('Gmail accounts and campaigns', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const connect = () =>
    h.services.accounts.connectGmail(
      { clientId: CLIENT_ID, clientSecret: 'client-secret-1', fromName: 'Me' },
      ctx(),
    );

  async function campaignTo(accountId: string, email: string): Promise<string> {
    const config: CampaignConfig = {
      steps: [
        {
          type: 'send_message',
          channel: 'email',
          executionMode: 'auto',
          delaySeconds: 0,
          subject: 'Hi {{firstName}}',
          body: 'Hello',
        },
      ],
      timezone: 'UTC',
      window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
      approvalMode: 'approve_each',
      emailAccountId: accountId,
    };
    const { campaigns, prospects } = h.services;
    const id = campaigns.create({ name: 'Gmail', config }, ctx()).id;
    campaigns.launch(id, ctx());
    campaigns.enroll(id, [prospects.createContact({ firstName: 'Bob', email }, ctx()).id], ctx());
    await h.run();
    return id;
  }
  const status = (campaign: string) =>
    h.services.campaigns.listEnrollments(campaign, { limit: 10, offset: 0 }).items[0];

  it('connects through the consent page and keeps only an encrypted refresh token', async () => {
    const account = await connect();
    expect(account).toMatchObject({
      provider: 'gmail_api',
      address: 'me@gmail.com',
      status: 'active',
      smtp: null,
    });
    const secrets = h.db.prepare('SELECT purpose FROM secrets ORDER BY purpose').all();
    expect(secrets).toEqual([{ purpose: 'oauth_client_secret' }, { purpose: 'oauth_refresh_token' }]);
    const everything = JSON.stringify(
      (h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (t) => h.db.prepare(`SELECT * FROM "${t.name}"`).all(),
      ),
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v),
    );
    for (const secret of ['refresh-1', 'access-1', 'client-secret-1', 'the-code']) {
      expect(everything, secret).not.toContain(secret);
      expect(h.logs.join('\n'), secret).not.toContain(secret);
    }
    // Replies are read from the moment of connecting.
    expect(h.db.prepare('SELECT uid_validity, last_uid FROM mailbox_cursors').get()).toEqual({
      uid_validity: 0,
      last_uid: 100,
    });
  });

  it('refuses a forged state, a declined consent and missing permissions, storing nothing', async () => {
    h.google.consent = 'wrong_state';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.stateMismatch' } });
    h.google.consent = 'deny';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.denied' } });
    h.google.consent = 'allow';
    h.google.grantedScope = 'https://www.googleapis.com/auth/gmail.send';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.scopesMissing' } });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
    expect(h.services.accounts.list()).toEqual([]);
  });

  it('sends through the API with our Message-ID and refreshes an expired token', async () => {
    const account = await connect();
    const campaign = await campaignTo(account.id, 'bob@beta.test');
    h.google.expireAccessToken();
    h.approve();
    await h.run();
    expect(h.google.sent).toHaveLength(1);
    expect(h.google.sent[0]?.raw).toMatch(/^From: Me <me@gmail\.com>$/m);
    expect(h.google.sent[0]?.messageId).toMatch(/^<[0-9a-f]{40}@gmail\.com>$/);
    expect(status(campaign)?.status).toBe('completed');
  });

  it('a server error after Gmail stored the message is reconciled by search, not re-sent', async () => {
    const account = await connect();
    const campaign = await campaignTo(account.id, 'bob@beta.test');
    h.google.queue('server_error_after_storing');
    h.approve();
    await h.run();
    expect(h.db.prepare('SELECT status FROM side_effects').get()).toEqual({ status: 'unknown' });
    h.clock.advance(60_000);
    await h.run();
    expect(h.google.sendCalls).toBe(1);
    expect(h.db.prepare('SELECT status, reconciled_by FROM side_effects').get()).toEqual({
      status: 'completed',
      reconciled_by: 'provider_lookup',
    });
    expect(status(campaign)?.status).toBe('completed');
  });

  it('a crash before Gmail answered, with nothing stored, sends once after the index grace period', async () => {
    const account = await connect();
    const campaign = await campaignTo(account.id, 'bob@beta.test');
    h.google.queue('server_error');
    h.approve();
    await h.run();
    h.clock.advance(60_000);
    await h.run();
    expect(h.google.sent).toHaveLength(0); // still inside the grace period: not re-sent
    h.clock.advance(SENT_INDEX_GRACE_MS);
    await h.run();
    expect(h.google.sent).toHaveLength(1);
    expect(status(campaign)?.status).toBe('completed');
  });

  it('an unreachable API is not sent and simply retried; an invalid recipient stops', async () => {
    const account = await connect();
    const campaign = await campaignTo(account.id, 'bob@beta.test');
    h.google.queue('unreachable');
    h.approve();
    await h.run();
    expect(h.db.prepare('SELECT status FROM side_effects').get()).toEqual({ status: 'not_sent' });
    h.clock.advance(60_000);
    await h.run();
    expect(h.google.sent).toHaveLength(1);
    expect(status(campaign)?.status).toBe('completed');

    const second = await campaignTo(account.id, 'broken@beta.test');
    h.google.queue('bad_request');
    h.approve();
    h.clock.advance(60_000);
    await h.run();
    expect(status(second)).toMatchObject({ status: 'stopped', stopReason: 'send_failed' });
  });

  it('a revoked refresh token puts the account on hold', async () => {
    const account = await connect();
    await campaignTo(account.id, 'bob@beta.test');
    h.google.expireAccessToken();
    h.google.refreshRevoked = true;
    h.approve();
    await h.run();
    expect(h.services.accounts.get(account.id).status).toBe('auth_required');
    expect(h.google.sent).toHaveLength(0);
  });

  it('reads replies through the history API into the inbox', async () => {
    const account = await connect();
    const campaign = await campaignTo(account.id, 'bob@beta.test');
    h.approve();
    await h.run();
    const sentId = h.google.sent[0]!.messageId;
    h.google.receive(inbound({ from: 'bob@beta.test', inReplyTo: sentId, body: 'Yes please.' }));
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(h.services.inbox.list('all', { limit: 10, offset: 0 }).items).toMatchObject([
      { title: 'Bob', lastSnippet: 'Yes please.', unread: true },
    ]);
    expect(status(campaign)).toMatchObject({ status: 'completed' });
    expect(h.db.prepare(`SELECT stop_reason FROM campaign_enrollments`).get()).toEqual({ stop_reason: null });
  });

  it('signing in again renews a revoked account instead of creating a second one', async () => {
    const account = await connect();
    h.services.accounts.markAuthRequired(account.id);
    const again = await connect();
    expect(again.id).toBe(account.id);
    expect(again.status).toBe('active');
    expect(h.services.accounts.list()).toHaveLength(1);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 2 }); // old ones deleted
  });

  it('restarts from the current position when Gmail no longer has the history', async () => {
    const account = await connect();
    await h.run();
    h.google.receive(inbound({ from: 'someone@else.test' }));
    h.google.oldestHistory = 1_000;
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(
      h.db.prepare('SELECT last_uid FROM mailbox_cursors WHERE channel_account_id = ?').get(account.id),
    ).toEqual({
      last_uid: h.google.historyId,
    });
  });
});
