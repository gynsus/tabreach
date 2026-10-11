import { microsoftAccountInputSchema, type CampaignConfigInput } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness, imapInput } from './harness.js';
import { grantedMailScopes, MICROSOFT_MAIL_SCOPES, microsoftAuthorizeUrl } from './microsoft.js';
import { pkce } from './oauth.js';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';
const ADDRESS = 'me@outlook.test';

describe('Microsoft sign-in pieces', () => {
  it('builds a PKCE sign-in URL for the tenant with offline access, both mail scopes and the address', () => {
    const { challenge, state } = pkce();
    const url = new URL(
      microsoftAuthorizeUrl(
        { clientId: CLIENT_ID, tenant: 'common' },
        { challenge, state, loginHint: ADDRESS },
      ),
    );
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT_ID,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      login_hint: ADDRESS,
      scope: ['offline_access', ...MICROSOFT_MAIL_SCOPES].join(' '),
    });
    expect(url.searchParams.has('redirect_uri')).toBe(false); // main adds its loopback address
  });

  it('accepts the granted scopes with or without the resource prefix', () => {
    expect(grantedMailScopes(MICROSOFT_MAIL_SCOPES.join(' '))).toBe(true);
    expect(grantedMailScopes('IMAP.AccessAsUser.All SMTP.Send offline_access')).toBe(true);
    expect(grantedMailScopes('https://outlook.office.com/IMAP.AccessAsUser.All')).toBe(false);
    expect(grantedMailScopes('')).toBe(true); // the server check decides
  });

  it('takes common, a directory ID or a domain as the tenant, and defaults to common', () => {
    const base = { address: ADDRESS, clientId: CLIENT_ID };
    expect(microsoftAccountInputSchema.parse(base).tenant).toBe('common');
    expect(microsoftAccountInputSchema.parse({ ...base, tenant: 'Contoso.onmicrosoft.com' }).tenant).toBe(
      'contoso.onmicrosoft.com',
    );
    expect(microsoftAccountInputSchema.safeParse({ ...base, tenant: '../evil' }).success).toBe(false);
    expect(microsoftAccountInputSchema.safeParse({ ...base, clientId: 'not-a-guid' }).success).toBe(false);
  });
});

describe('Microsoft accounts (IMAP/SMTP with XOAUTH2)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const connect = (over: { address?: string; tenant?: string } = {}) =>
    h.services.accounts.connectMicrosoft(
      {
        address: over.address ?? ADDRESS,
        clientId: CLIENT_ID,
        tenant: over.tenant ?? 'common',
        fromName: 'Me',
      },
      ctx(),
    );
  const secrets = () =>
    h.db.prepare('SELECT id, purpose FROM secrets').all() as { id: string; purpose: string }[];
  const dump = () =>
    JSON.stringify(
      (h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
        (t) => h.db.prepare(`SELECT * FROM "${t.name}"`).all(),
      ),
      (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v),
    );

  async function campaignTo(accountId: string, email: string): Promise<string> {
    const config: CampaignConfigInput = {
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
    const id = campaigns.create({ name: 'Outlook', config }, ctx()).id;
    campaigns.launch(id, ctx());
    campaigns.enroll(id, [prospects.createContact({ firstName: 'Bob', email }, ctx()).id], ctx());
    await h.run();
    return id;
  }

  it('connects through the sign-in page, tests both servers with the token and keeps only a refresh token', async () => {
    const account = await connect();
    expect(account).toMatchObject({
      provider: 'imap_smtp',
      signIn: 'microsoft',
      address: ADDRESS,
      status: 'active',
      smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
      imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
      appendToSent: false,
      oauthClient: { clientId: CLIENT_ID, tenant: 'common' },
    });
    expect(h.microsoft.authorizeUrls[0]?.searchParams.get('login_hint')).toBe(ADDRESS);
    expect(secrets()).toMatchObject([{ purpose: 'oauth_refresh_token' }]);
    // Tokens never appear in plaintext in the database or the logs.
    expect(dump()).not.toMatch(/ms-(access|refresh)-/);
    expect(h.logs.join('\n')).not.toMatch(/ms-(access|refresh)-/);
    expect(h.services.audit.list({ objectType: 'account', limit: 1 })[0]).toMatchObject({
      actionType: 'account.connected',
      payload: { provider: 'imap_smtp', signIn: 'microsoft' },
    });
  });

  it('sends a campaign message over SMTP signed in with the token', async () => {
    const account = await connect();
    await campaignTo(account.id, 'bob@beta.test');
    h.services.approvals.pending().forEach((a) => h.services.approvals.approve(a.id, a.contentHash, ctx()));
    await h.run();
    expect(h.mail.delivered).toHaveLength(1);
    expect(h.mail.delivered[0]?.raw).toMatch(/^From: "?Me"? <me@outlook\.test>/m);
    // Outlook keeps sent mail itself: a check of Sent settles it, no copy is appended.
    expect(h.mail.sent).toHaveLength(1);
    expect(h.db.prepare('SELECT status FROM side_effects').all()).toEqual([{ status: 'completed' }]);
  });

  it('renews the access token when it runs out and keeps the new refresh token Microsoft hands out', async () => {
    h.microsoft.expiresIn = 60; // inside the renewal margin: every use renews
    const account = await connect();
    const first = secrets()[0]!.id;
    expect((await h.services.accounts.test(account.id)).smtp.ok).toBe(true);
    expect(h.microsoft.refreshCalls).toBe(1);
    const second = secrets();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first);
    // The fake accepts only the newest refresh token: a second renewal proves the new one was kept.
    expect((await h.services.accounts.test(account.id)).imap.ok).toBe(true);
    expect(h.microsoft.refreshCalls).toBe(2);
  });

  it('renews once for several callers at the same time', async () => {
    h.microsoft.expiresIn = 60;
    const account = await connect();
    const checks = await Promise.all([1, 2, 3].map(() => h.services.accounts.test(account.id)));
    expect(checks.every((c) => c.smtp.ok && c.imap.ok)).toBe(true);
    expect(h.microsoft.refreshCalls).toBe(1);
    expect(secrets()).toHaveLength(1);
  });

  it('a grant Microsoft no longer honours puts the account on hold; signing in again renews the same account', async () => {
    h.microsoft.expiresIn = 60;
    const account = await connect();
    h.microsoft.grantGone = true;
    await campaignTo(account.id, 'bob@beta.test');
    h.services.approvals.pending().forEach((a) => h.services.approvals.approve(a.id, a.contentHash, ctx()));
    await h.run();
    expect(h.mail.delivered).toHaveLength(0);
    expect(h.services.accounts.get(account.id).status).toBe('auth_required');
    expect(h.db.prepare(`SELECT status FROM side_effects WHERE status = 'completed'`).all()).toEqual([]);

    h.microsoft.grantGone = false;
    const old = secrets()[0]!.id;
    const again = await connect();
    expect(again).toMatchObject({ id: account.id, status: 'active' });
    expect(secrets()).toHaveLength(1);
    expect(secrets()[0]!.id).not.toBe(old);
  });

  it('an inbox whose sign-in expired puts the account on hold and stops polling', async () => {
    h.microsoft.expiresIn = 60;
    const account = await connect();
    await h.run();
    h.microsoft.grantGone = true;
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(h.services.accounts.get(account.id).status).toBe('auth_required');
    expect(h.services.jobs.byDedupeKey(`poll:${account.id}`)).toBeUndefined();
  });

  it('signed in as another account: the servers refuse the token and nothing is stored', async () => {
    h.microsoft.signedInAs = 'someone-else@outlook.test';
    await expect(connect()).rejects.toMatchObject({
      problem: { code: 'VALIDATION_FAILED', fields: { address: 'account.oauthRefused' } },
    });
    expect(secrets()).toEqual([]);
    expect(h.services.accounts.list()).toEqual([]);
  });

  it('a declined or refused sign-in stores nothing and says why', async () => {
    h.microsoft.consent = 'deny';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.denied' } });
    h.microsoft.consent = 'wrong_state';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.stateMismatch' } });
    h.microsoft.consent = 'unauthorized_client';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.microsoftClient' } });
    h.microsoft.consent = 'allow';
    h.microsoft.clientId = '99999999-2222-3333-4444-555555555555'; // the app is not the one registered
    await expect(connect()).rejects.toMatchObject({
      problem: { code: 'VALIDATION_FAILED', fields: { clientId: 'oauth.microsoftClient' } },
    });
    expect(secrets()).toEqual([]);
  });

  it('needs a refresh token and both mail permissions', async () => {
    h.microsoft.giveRefreshToken = false;
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.noRefreshToken' } });
    h.microsoft.giveRefreshToken = true;
    h.microsoft.grantedScope = 'https://outlook.office.com/IMAP.AccessAsUser.All';
    await expect(connect()).rejects.toMatchObject({ problem: { detail: 'oauth.scopesMissing' } });
    expect(secrets()).toEqual([]);
  });

  it('does not take over a mailbox already connected with a password, and has no password to change', async () => {
    await h.services.accounts.connectImap(imapInput({ address: ADDRESS, username: ADDRESS }), ctx());
    await expect(connect()).rejects.toMatchObject({ problem: { fields: { address: 'account.duplicate' } } });
    expect(h.microsoft.authorizeUrls).toHaveLength(0); // refused before the browser opened

    const other = await connect({ address: 'other@outlook.test' }).catch(() => null);
    expect(other).toBeNull(); // signed in as me@outlook.test: refused
    h.microsoft.signedInAs = 'other@outlook.test';
    const account = await connect({ address: 'other@outlook.test' });
    await expect(h.services.accounts.update({ id: account.id, password: 'x' }, ctx())).rejects.toMatchObject({
      problem: { detail: 'account.noPassword' },
    });
  });

  it('disconnecting deletes the refresh token', async () => {
    const account = await connect();
    await h.services.accounts.disconnect(account.id, ctx());
    expect(secrets()).toEqual([]);
    expect(h.services.accounts.list()).toEqual([]);
  });
});
