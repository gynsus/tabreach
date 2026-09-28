import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  RpcPeer,
  uuidv7,
  type CampaignConfig,
  type ImapAccountInput,
  type Logger,
} from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppServices } from '../app-handlers.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';
import { fakeClock } from '../db/test-db.js';
import { Dispatcher } from '../jobs/dispatcher.js';
import type { SecretCipher } from '../secrets/secrets.js';
import { SENT_INDEX_GRACE_MS } from './email-channel.js';
import { FakeMail } from './fake-mail.js';

const ctx = () => ({ correlationId: uuidv7() });
const PASSWORD = 'app-password';

/** Reversible and visibly not plaintext, like main's safeStorage. */
const cipher: SecretCipher = {
  encrypt: async (p) => Buffer.from(`enc:${[...p].reverse().join('')}`).toString('base64'),
  decrypt: async (c) => [...Buffer.from(c, 'base64').toString().replace(/^enc:/, '')].reverse().join(''),
};

/** Captures every log line, to prove no secret is ever logged. */
function capturingLogger(lines: string[]): Logger {
  const log = (obj: object, msg?: string) => void lines.push(JSON.stringify({ ...obj, msg }));
  const logger: Logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
  return logger;
}

const imapInput = (over: Partial<ImapAccountInput> = {}): ImapAccountInput => ({
  address: 'Me@Acme.test',
  fromName: 'Ann Sender',
  smtp: { host: 'smtp.acme.test', port: 587, security: 'starttls' },
  imap: { host: 'imap.acme.test', port: 993, security: 'tls' },
  username: 'me@acme.test',
  password: PASSWORD,
  appendToSent: null,
  limits: { dailyLimit: 50, minSpacingSeconds: 0 },
  ...over,
});

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'tabreach-email-'));
  readonly clock = fakeClock('2026-09-28T10:00:00.000Z');
  readonly mail = new FakeMail();
  readonly logs: string[] = [];
  db!: DatabaseSync;
  services!: AppServices;
  dispatcher!: Dispatcher;

  async open(): Promise<this> {
    this.db = openDatabase(join(this.dir, 'app.db'));
    await migrate(this.db, migrations, { backupDir: join(this.dir, 'backups') });
    this.boot();
    return this;
  }

  boot(): void {
    this.services = new AppServices(this.db, {
      now: this.clock.now,
      cipher,
      mailClients: this.mail,
      logger: capturingLogger(this.logs),
    });
    this.dispatcher = new Dispatcher({
      queue: this.services.jobs,
      now: this.clock.now,
      logger: capturingLogger(this.logs),
    });
    for (const type of this.services.engine.jobTypes()) this.dispatcher.register(type);
    this.dispatcher.start();
    this.dispatcher.pause();
    this.services.engine.resync();
  }

  run = () => this.dispatcher.runDue();

  async campaignTo(email: string): Promise<{ campaign: string; accountId: string }> {
    const accountId = (await this.services.accounts.connectImap(imapInput(), ctx())).id;
    const config: CampaignConfig = {
      steps: [
        {
          type: 'send_message',
          channel: 'email',
          executionMode: 'auto',
          delaySeconds: 0,
          subject: 'Hi {{firstName}}',
          body: 'Hello {{firstName}}',
        },
      ],
      timezone: 'UTC',
      window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
      approvalMode: 'approve_each',
      emailAccountId: accountId,
    };
    const { campaigns, prospects } = this.services;
    const campaign = campaigns.create({ name: 'Email', config }, ctx()).id;
    campaigns.launch(campaign, ctx());
    campaigns.enroll(
      campaign,
      [prospects.createContact({ firstName: 'Bob', lastName: 'Lee', email }, ctx()).id],
      ctx(),
    );
    await this.run();
    return { campaign, accountId };
  }

  approve(): void {
    for (const a of this.services.approvals.pending())
      this.services.approvals.approve(a.id, a.contentHash, ctx());
  }

  status(campaign: string) {
    return this.services.campaigns.listEnrollments(campaign, { limit: 10, offset: 0 }).items[0];
  }

  ledger() {
    return this.db.prepare('SELECT status, reconciled_by, channel_account_id FROM side_effects').all();
  }

  close(): void {
    this.dispatcher.stop();
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

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
    h.services.accounts.disconnect(gmail.id, ctx());
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
    const [attention] = (await app.request('jobs.needsAttention', {})).items;
    expect(attention?.unknownSideEffectId).toBe(effect.id);
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
