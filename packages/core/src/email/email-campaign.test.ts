import { RpcError, RpcPeer, uuidv7 } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SENT_INDEX_GRACE_MS } from './email-channel.js';
import { ctx, Harness, imapInput, inbound, PASSWORD } from './harness.js';
import { PARTIAL_MESSAGE_BYTES } from './transport.js';

describe('email accounts', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  it('connects after a successful check and keeps the password only encrypted', async () => {
    const account = await h.services.accounts.connectImap(imapInput(), ctx());
    expect(account).toMatchObject({
      address: 'me@acme.test',
      status: 'active',
      appendToSent: true,
      fromName: 'Ann Sender',
    });
    expect(JSON.stringify(account)).not.toContain(PASSWORD);

    // Nowhere in the database but `secrets`, and not there in plaintext either.
    const tables = (
      h.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((t) => t.name);
    for (const table of tables) {
      const rows = JSON.stringify(h.db.prepare(`SELECT * FROM "${table}"`).all(), (_k, v: unknown) =>
        v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
      );
      expect(rows, table).not.toContain(PASSWORD);
    }
    expect(h.logs.join('\n')).not.toContain(PASSWORD);
    expect(
      await h.services.secrets.reveal(
        h.db.prepare('SELECT secret_id AS id FROM channel_accounts').get()!.id as string,
      ),
    ).toBe(PASSWORD);
  });

  it('refuses a wrong password with a field error and stores nothing', async () => {
    await expect(
      h.services.accounts.connectImap(imapInput({ password: 'wrong' }), ctx()),
    ).rejects.toMatchObject({
      problem: { code: 'VALIDATION_FAILED', fields: { password: 'account.authFailed' } },
    });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
    expect(h.services.accounts.list()).toEqual([]);
  });

  it('connecting the same address twice at once leaves one account and no stray secrets', async () => {
    const results = await Promise.allSettled([
      h.services.accounts.connectImap(imapInput(), ctx()),
      h.services.accounts.connectImap(imapInput(), ctx()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 1 });
  });

  it('knows which providers keep sent mail, refuses duplicates, and disconnects', async () => {
    const gmail = await h.services.accounts.connectImap(
      imapInput({ address: 'me@gmail.com', smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } }),
      ctx(),
    );
    expect(gmail.appendToSent).toBe(false);
    await expect(
      h.services.accounts.connectImap(
        imapInput({ address: 'ME@gmail.com', smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } }),
        ctx(),
      ),
    ).rejects.toBeInstanceOf(RpcError);
    await h.services.accounts.disconnect(gmail.id, ctx());
    expect(h.services.accounts.list()).toEqual([]);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM secrets').get()).toEqual({ n: 0 });
  });
});

describe('campaigns over email', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  it('sends one message with a stable Message-ID and records it', async () => {
    const { campaign, accountId } = await h.campaignTo('bob@beta.test');
    h.approve();
    await h.run();
    expect(h.mail.delivered).toHaveLength(1);
    const [msg] = h.mail.delivered;
    expect(msg?.raw).toMatch(/^From: Ann Sender <me@acme\.test>$/m);
    expect(msg?.raw).toMatch(/^To: Bob Lee <bob@beta\.test>$/m);
    expect(msg?.messageId).toMatch(/^<[0-9a-f]{40}@acme\.test>$/);
    expect(h.mail.sent).toEqual([msg?.messageId]); // appended to Sent: not a Gmail/Outlook server
    expect(h.ledger()).toEqual([{ status: 'completed', reconciled_by: null, channel_account_id: accountId }]);
    expect(h.status(campaign)?.status).toBe('completed');
  });

  it('crash after the server took the message: reconciled from Sent, never sent twice', async () => {
    h.mail.serverSavesSent = true;
    const { campaign } = await h.campaignTo('bob@beta.test');
    h.mail.queue('hang_after_accept');
    h.approve();
    void h.run(); // core dies while waiting for the SMTP answer
    await vi.waitFor(() => expect(h.mail.delivered).toHaveLength(1));
    h.boot();
    await h.run();
    expect(h.mail.delivered).toHaveLength(1);
    expect(h.ledger()).toMatchObject([{ status: 'completed', reconciled_by: 'provider_lookup' }]);
    expect(h.status(campaign)?.status).toBe('completed');
  });

  it('crash before the server took it, on a server that keeps Sent: waits out the index lag, then sends once', async () => {
    await h.services.accounts.connectImap(
      imapInput({ address: 'other@gmail.com', smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' } }),
      ctx(),
    );
    const { campaign } = await h.campaignTo('bob@beta.test');
    // The campaign uses the first account (acme, appends itself); switch it to the Gmail one.
    const gmailId = h.services.accounts.list().find((a) => a.address === 'other@gmail.com')!.id;
    const draft = h.services.campaigns.get(campaign).config;
    h.services.campaigns.update({ id: campaign, config: { ...draft, emailAccountId: gmailId } }, ctx());
    h.services.campaigns.launch(campaign, ctx());
    h.services.campaigns.enroll(
      campaign,
      [h.services.prospects.createContact({ firstName: 'Eve', email: 'eve@gamma.test' }, ctx()).id],
      ctx(),
    );
    await h.run();
    const eveApproval = h.services.approvals.pending().find((a) => a.target === 'eve@gamma.test')!;
    h.mail.queue('hang_before_accept');
    h.services.approvals.approve(eveApproval.id, eveApproval.contentHash, ctx());
    void h.run();
    await vi.waitFor(() => expect(h.mail.attempts).toBe(1)); // eve's send reached the server and hangs

    h.boot();
    await h.run();
    expect(h.mail.delivered.filter((d) => d.to === 'eve@gamma.test')).toHaveLength(0); // still inside the grace period
    h.clock.advance(SENT_INDEX_GRACE_MS);
    await h.run();
    expect(h.mail.delivered.filter((d) => d.to === 'eve@gamma.test')).toHaveLength(1);
  });

  it('an unconfirmed send on a server without its own Sent copy waits for a person, then resumes', async () => {
    const { campaign } = await h.campaignTo('bob@beta.test');
    h.mail.queue({ error: { code: 'ECONNECTION', stage: 'submit' } as never });
    h.approve();
    await h.run();
    expect(h.ledger()).toMatchObject([{ status: 'unknown' }]);
    // Retries keep reconciling (nothing in Sent, and absence proves nothing here) until the job is dead.
    for (let i = 0; i < 8; i++) {
      h.clock.advance(60 * 60_000);
      await h.run();
    }
    expect(h.mail.delivered).toHaveLength(0);
    const [job] = h.services.jobs.needsAttention();
    expect(job?.status).toBe('dead');
    const effect = h.db.prepare('SELECT id FROM side_effects').get() as { id: string };

    expect(job?.id).toBeDefined();
    // The user checked their mailbox: it was not sent. Only now may TabReach send it.
    const [appSide, coreSide] = createEndpointPair();
    h.services.register(new RpcPeer(coreSide));
    const app = new RpcPeer(appSide);
    const [uncertain] = (await app.request('sideEffects.uncertain', {})).items;
    expect(uncertain).toMatchObject({ id: effect.id, checking: false });
    await app.request('sideEffects.resolve', { id: effect.id, outcome: 'not_sent' });
    await expect(
      app.request('sideEffects.resolve', { id: effect.id, outcome: 'not_sent' }),
    ).rejects.toMatchObject({
      problem: { code: 'CONFLICT' },
    });
    await h.run();
    expect(h.mail.delivered).toHaveLength(1);
    expect(h.status(campaign)?.status).toBe('completed');
  });

  it('a refused recipient stops the sequence without retrying', async () => {
    const { campaign } = await h.campaignTo('nobody@beta.test');
    h.mail.queue({ error: { code: 'EENVELOPE', responseCode: 550, stage: 'submit' } as never });
    h.approve();
    await h.run();
    expect(h.status(campaign)).toMatchObject({ status: 'stopped', stopReason: 'send_failed' });
    expect(h.ledger()).toMatchObject([{ status: 'not_sent' }]);
  });

  it('a password the server no longer accepts puts the account on hold', async () => {
    const { accountId } = await h.campaignTo('bob@beta.test');
    h.mail.password = 'changed-elsewhere';
    h.approve();
    await h.run();
    expect(h.services.accounts.get(accountId).status).toBe('auth_required');
    expect(h.mail.delivered).toHaveLength(0);
    expect(h.logs.join('\n')).not.toContain(PASSWORD);
  });

  it('refuses to launch email steps without an active account', () => {
    const { campaigns } = h.services;
    const id = campaigns.create(
      {
        name: 'No account',
        config: {
          steps: [
            {
              type: 'send_message',
              channel: 'email',
              executionMode: 'auto',
              delaySeconds: 0,
              subject: 'Hi',
              body: 'Hi',
            },
          ],
          timezone: null,
          window: null,
          approvalMode: 'approve_each',
          emailAccountId: null,
        },
      },
      ctx(),
    ).id;
    expect(() => campaigns.launch(id, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { emailAccountId: 'account.required' } }),
      }),
    );
  });
});

describe('replies', () => {
  let h: Harness;
  const DAY = 24 * 60 * 60 * 1000;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  /** Acme with Bob and Carol; a two-step campaign (second step after 4 days) sent to both. */
  async function sentToAcme(firstSubject = 'First') {
    const { accounts, prospects, campaigns } = h.services;
    const accountId = (await accounts.connectImap(imapInput(), ctx())).id;
    const acme = prospects.createCompany({ name: 'Beta Co', website: 'beta.test' }, ctx()).id;
    const bob = prospects.createContact(
      { firstName: 'Bob', email: 'bob@beta.test', companyId: acme },
      ctx(),
    ).id;
    const carol = prospects.createContact(
      { firstName: 'Carol', email: 'carol@beta.test', companyId: acme },
      ctx(),
    ).id;
    const message = (subject: string, delaySeconds: number) =>
      ({
        type: 'send_message',
        channel: 'email',
        executionMode: 'auto',
        delaySeconds,
        subject,
        body: 'Hi {{firstName}}',
      }) as const;
    const campaign = campaigns.create(
      {
        name: 'Two steps',
        config: {
          steps: [message(firstSubject, 0), message('Follow-up', 4 * 24 * 60 * 60)],
          timezone: 'UTC',
          window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
          approvalMode: 'approve_each',
          emailAccountId: accountId,
        },
      },
      ctx(),
    ).id;
    campaigns.launch(campaign, ctx());
    campaigns.enroll(campaign, [bob, carol], ctx());
    await h.run();
    h.approve();
    await h.run();
    const idOf = (to: string) => h.mail.delivered.find((d) => d.to === to)!.messageId;
    return { accountId, campaign, acme, bob, carol, bobMessageId: idOf('bob@beta.test') };
  }

  const enrollment = (campaign: string, contactId: string) =>
    h.services.campaigns
      .listEnrollments(campaign, { limit: 10, offset: 0 })
      .items.find((e) => e.contactId === contactId);

  async function deliver(raw: string) {
    h.mail.receive(raw);
    h.clock.advance(2 * 60_000);
    await h.run();
  }

  it('a reply in the thread lands in the inbox and stops the sequence, and the company’s', async () => {
    const s = await sentToAcme();
    await deliver(inbound({ from: 'Bob <bob@beta.test>', inReplyTo: s.bobMessageId, body: 'Sounds good.' }));
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
    expect(enrollment(s.campaign, s.carol)).toMatchObject({
      status: 'stopped',
      stopReason: 'company_replied',
    });

    const { items, unread } = h.services.inbox.list('all', { limit: 10, offset: 0 });
    expect(unread).toBe(1);
    expect(items).toMatchObject([
      { title: 'Bob', unread: true, lastClassification: 'reply', lastSnippet: 'Sounds good.' },
    ]);
    const thread = h.services.inbox.get(items[0]!.id);
    expect(thread.messages.map((m) => [m.direction, m.matchStrength])).toEqual([
      ['outbound', null],
      ['inbound', 'thread'],
    ]);
    // The follow-up never goes out.
    h.clock.advance(5 * DAY);
    await h.run();
    expect(h.services.approvals.pending()).toEqual([]);
  });

  it('without the company stop in the policy, only the contact’s sequence stops', async () => {
    h.services.policy.update({ ...h.services.policy.current(), companyStopOnReply: false });
    const s = await sentToAcme();
    await deliver(inbound({ from: 'bob@beta.test', subject: 'A new question' })); // new message, no thread
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
    expect(enrollment(s.campaign, s.carol)?.status).toBe('active');
  });

  it('a sender that only matches the company domain is a possible reply, for the user to decide', async () => {
    const s = await sentToAcme();
    await deliver(inbound({ from: 'dave@mail.beta.test', subject: 'Who are you?' }));
    expect(enrollment(s.campaign, s.bob)?.status).toBe('active');
    const [review] = h.services.inbox.list('review', { limit: 10, offset: 0 }).items;
    expect(review).toMatchObject({ title: 'Beta Co', needsReview: true });
    const message = h.services.inbox.get(review!.id).messages[0]!;
    expect(message).toMatchObject({ matchStrength: 'domain_only', reviewStatus: 'pending' });
    h.services.inbox.review(message.id, 'confirm', ctx());
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'company_replied' });
    expect(() => h.services.inbox.review(message.id, 'dismiss', ctx())).toThrow(RpcError);
  });

  it('out-of-office is kept without stopping; newsletters and unrelated mail are not stored', async () => {
    const s = await sentToAcme();
    await deliver(
      inbound({
        from: 'bob@beta.test',
        subject: 'Automatic reply: First',
        inReplyTo: s.bobMessageId,
        headers: 'Auto-Submitted: auto-replied',
      }),
    );
    await deliver(
      inbound({ from: 'bob@beta.test', subject: 'Beta news', headers: 'List-Id: <news.beta.test>' }),
    );
    await deliver(inbound({ from: 'friend@elsewhere.test', subject: 'Dinner?' }));
    await deliver(inbound({ from: 'noreply@beta.test', subject: 'Your invoice' }));
    expect(enrollment(s.campaign, s.bob)?.status).toBe('active');
    const stored = h.db.prepare(`SELECT classification FROM messages WHERE direction = 'inbound'`).all();
    expect(stored).toEqual([{ classification: 'out_of_office' }]);
  });

  it('a hard bounce marks the address, suppresses it and stops the sequence; a delay does not', async () => {
    const s = await sentToAcme();
    const dsn = (recipient: string, status: string, original: string) =>
      [
        'From: MAILER-DAEMON@mx.acme.test',
        'To: me@acme.test',
        'Subject: Undelivered Mail',
        `Message-ID: <${uuidv7()}@mx.acme.test>`,
        'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
        '',
        '--B',
        'Content-Type: message/delivery-status',
        '',
        `Final-Recipient: rfc822; ${recipient}`,
        `Action: ${status.startsWith('5') ? 'failed' : 'delayed'}`,
        `Status: ${status}`,
        '',
        '--B',
        'Content-Type: text/rfc822-headers',
        '',
        `Message-ID: ${original}`,
        '',
        '--B--',
        '',
      ].join('\n');
    const carolMessageId = h.mail.delivered.find((d) => d.to === 'carol@beta.test')!.messageId;
    await deliver(dsn('carol@beta.test', '4.4.1', carolMessageId));
    expect(enrollment(s.campaign, s.carol)?.status).toBe('active');
    await deliver(dsn('bob@beta.test', '5.1.1', s.bobMessageId));
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'bounced' });
    expect(h.services.prospects.getContact(s.bob).emailStatus).toBe('bounced');
    expect(h.services.suppressions.list({ limit: 10, offset: 0 }).items).toMatchObject([
      { kind: 'email', value: 'bob@beta.test', reason: 'bounce' },
    ]);
    expect(enrollment(s.campaign, s.carol)?.status).toBe('active'); // a bounce is not a reply
  });

  it('starts from now, ingests each message once, and survives a UIDVALIDITY change', async () => {
    h.mail.receive(inbound({ from: 'bob@beta.test', subject: 'Old mail before connecting' }));
    const s = await sentToAcme();
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound'`).get()).toEqual({
      n: 0,
    });
    const reply = inbound({ from: 'carol@beta.test', inReplyTo: s.bobMessageId, id: 'same' });
    await deliver(reply);
    // The same message again (e.g. copied back into the inbox): stored once.
    await deliver(reply);
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound'`).get()).toEqual({
      n: 1,
    });
    h.mail.uidValidity = 2;
    await deliver(inbound({ from: 'bob@beta.test', subject: 'After the mailbox was rebuilt' }));
    // A new UIDVALIDITY restarts from the current position instead of re-reading the mailbox.
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound'`).get()).toEqual({
      n: 1,
    });
  });

  it('an inbox that refuses the password puts the account on hold and stops polling', async () => {
    const accountId = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    await h.run();
    h.mail.password = 'changed';
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(h.services.accounts.get(accountId).status).toBe('auth_required');
    expect(h.services.jobs.byDedupeKey(`poll:${accountId}`)).toBeUndefined();
  });
  // Audit 3.5 ----------------------------------------------------------------------------------

  it('reads only the start of a large reply, which is still enough to stop the sequence', async () => {
    const s = await sentToAcme();
    const big = 'x'.repeat(3 * 1024 * 1024);
    await deliver(
      inbound({ from: 'bob@beta.test', inReplyTo: s.bobMessageId, body: `Yes, call me.\n${big}` }),
    );
    expect(h.mail.downloads.at(-1)?.maxBytes).toBe(PARTIAL_MESSAGE_BYTES);
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
  });

  it('a contact who replied is on hold in every campaign until the user allows it', async () => {
    const s = await sentToAcme();
    await deliver(inbound({ from: 'bob@beta.test', inReplyTo: s.bobMessageId }));
    const { campaigns, prospects } = h.services;
    const other = campaigns.create(
      {
        name: 'Another',
        config: {
          steps: [
            {
              type: 'send_message',
              channel: 'email',
              executionMode: 'auto',
              delaySeconds: 0,
              subject: 'Hi',
              body: 'Hi',
            },
          ],
          timezone: 'UTC',
          window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
          approvalMode: 'approve_each',
          emailAccountId: s.accountId,
        },
      },
      ctx(),
    ).id;
    campaigns.launch(other, ctx());
    const dave = prospects.createContact({ firstName: 'Dave', email: 'dave@elsewhere.test' }, ctx()).id;
    expect(campaigns.enroll(other, [s.bob, s.carol, dave], ctx())).toMatchObject({ enrolled: 1, onHold: 2 });
    expect(h.services.policy.replyHold(s.bob, s.acme)).toBe('replied');
    expect(h.services.policy.replyHold(s.carol, s.acme)).toBe('company_replied');

    // Enrolled before the hold existed? The final pre-send check stops it too.
    h.db
      .prepare('UPDATE contacts SET reply_hold_released_at = ? WHERE id = ?')
      .run(h.clock.now().toISOString(), s.carol);
    h.clock.advance(1_000);
    expect(campaigns.enroll(other, [s.carol], ctx())).toMatchObject({ enrolled: 1, onHold: 0 });
  });

  it('a reply is a reply even when the campaign subject mentions absence or auto replies', async () => {
    const s = await sentToAcme('Отсутствие простоев и auto reply');
    await deliver(
      inbound({
        from: 'bob@beta.test',
        subject: 'Re: Отсутствие простоев и auto reply',
        inReplyTo: s.bobMessageId,
      }),
    );
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
  });

  it('a person answering from a group mailbox in our thread stops the sequence', async () => {
    const s = await sentToAcme();
    await deliver(
      inbound({
        from: 'bob@beta.test',
        inReplyTo: s.bobMessageId,
        headers: 'List-Id: <sales.beta.test>\nPrecedence: list',
      }),
    );
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
  });

  it('reads the inbox right before a send, so a reply waiting there stops it', async () => {
    const s = await sentToAcme();
    h.clock.advance(4 * DAY);
    await h.run(); // follow-ups are due; they wait for approval
    // Polling stalls (e.g. the Mac just woke up) while a reply sits in the inbox.
    h.db.prepare(`DELETE FROM jobs WHERE type = 'mailbox.poll'`).run();
    h.mail.receive(inbound({ from: 'bob@beta.test', inReplyTo: s.bobMessageId }));
    h.clock.advance(10 * 60_000);
    h.approve();
    await h.run();
    expect(h.mail.delivered.filter((d) => d.to === 'bob@beta.test')).toHaveLength(1); // only the first
    expect(enrollment(s.campaign, s.bob)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
  });

  it('does not send while the inbox cannot be read', async () => {
    const s = await sentToAcme();
    h.clock.advance(4 * DAY);
    await h.run();
    h.mail.mailboxDown = true;
    h.clock.advance(40 * 60_000);
    h.approve();
    await h.run();
    expect(h.mail.delivered.filter((d) => d.to === 'carol@beta.test')).toHaveLength(1);
    void s;
  });

  it('matches an enrolled role address by address', async () => {
    const { accounts, prospects, campaigns } = h.services;
    const accountId = (await accounts.connectImap(imapInput(), ctx())).id;
    const hr = prospects.createContact({ firstName: 'HR', email: 'hr@beta.test' }, ctx()).id;
    const id = campaigns.create(
      {
        name: 'HR',
        config: {
          steps: [
            {
              type: 'send_message',
              channel: 'email',
              executionMode: 'auto',
              delaySeconds: 0,
              subject: 'Hi',
              body: 'Hi',
            },
            {
              type: 'send_message',
              channel: 'email',
              executionMode: 'auto',
              delaySeconds: 86_400,
              subject: 'Again',
              body: 'Hi',
            },
          ],
          timezone: 'UTC',
          window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
          approvalMode: 'approve_each',
          emailAccountId: accountId,
        },
      },
      ctx(),
    ).id;
    campaigns.launch(id, ctx());
    campaigns.enroll(id, [hr], ctx());
    await h.run();
    h.approve();
    await h.run();
    await deliver(inbound({ from: 'hr@beta.test', subject: 'Question' })); // no thread headers
    expect(enrollment(id, hr)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
  });

  it('stores nothing from contacts or companies TabReach never wrote to, and ignores their bounces', async () => {
    const s = await sentToAcme();
    const { prospects } = h.services;
    const other = prospects.createCompany({ name: 'Gamma', website: 'gamma.test' }, ctx()).id;
    const zed = prospects.createContact(
      { firstName: 'Zed', email: 'zed@gamma.test', companyId: other },
      ctx(),
    ).id;
    await deliver(inbound({ from: 'zed@gamma.test', subject: 'Private note' }));
    await deliver(inbound({ from: 'yan@gamma.test', subject: 'Hello' }));
    await deliver(
      [
        'From: postmaster@evil.test',
        'To: me@acme.test',
        'Subject: Undeliverable',
        'X-Failed-Recipients: zed@gamma.test',
        'Content-Type: text/plain',
        '',
        'Status: 5.1.1',
        '',
      ].join('\n'),
    );
    expect(h.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE direction = 'inbound'`).get()).toEqual({
      n: 0,
    });
    expect(h.services.prospects.getContact(zed).emailStatus).toBe('unknown');
    void s;
  });
});
