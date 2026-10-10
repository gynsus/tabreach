import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  uuidv7,
  type CampaignConfigInput,
  type ImapAccountInput,
  type Logger,
  type RpcPeer,
} from '@tabreach/protocol';
import { AppServices } from '../app-handlers.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';
import { fakeClock } from '../db/test-db.js';
import { Dispatcher } from '../jobs/dispatcher.js';
import type { SecretCipher } from '../secrets/secrets.js';
import { FakeAnthropic, FakeChatCompletions } from '../ai/fake-anthropic.js';
import type { Http } from './gmail.js';
import { FakeGoogle } from './fake-google.js';
import { FakeMail } from './fake-mail.js';

/** Test harness for email: a core without Electron, with fake SMTP/IMAP and a fake Google. */
export const ctx = () => ({ correlationId: uuidv7() });
export const PASSWORD = 'app-password';

/** Reversible and visibly not plaintext, like main's safeStorage. */
export const cipher: SecretCipher = {
  encrypt: async (p) => Buffer.from(`enc:${[...p].reverse().join('')}`).toString('base64'),
  decrypt: async (c) => [...Buffer.from(c, 'base64').toString().replace(/^enc:/, '')].reverse().join(''),
};

/** Captures every log line, to prove no secret is ever logged. */
export function capturingLogger(lines: string[]): Logger {
  const log = (obj: object, msg?: string) => void lines.push(JSON.stringify({ ...obj, msg }));
  const logger: Logger = { debug: log, info: log, warn: log, error: log, child: () => logger };
  return logger;
}

export const imapInput = (over: Partial<ImapAccountInput> = {}): ImapAccountInput => ({
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

export class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'tabreach-email-'));
  readonly clock = fakeClock('2026-09-28T10:00:00.000Z');
  readonly mail = new FakeMail();
  readonly google = new FakeGoogle();
  readonly anthropic = new FakeAnthropic();
  readonly chat = new FakeChatCompletions();
  /** HTTP for research fetching; tests point it at the fixture site. */
  webHttp: Http = () => Promise.reject(new Error('no web in this test'));
  /** The browser worker as core sees it; none unless a test sets one. */
  worker: Pick<RpcPeer, 'request'> | null = null;
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
      gmail: this.google.deps,
      aiHttp: (url, init) =>
        url.startsWith('https://api.anthropic.com')
          ? this.anthropic.http(url, init)
          : this.chat.http(url, init),
      webHttp: (url, init) => this.webHttp(url, init),
      worker: () => this.worker,
      sleep: async () => {},
      // Fixture hosts (acme.test) stand for public sites.
      resolveHost: async () => ['93.184.216.34'],
      logger: capturingLogger(this.logs),
    });
    this.dispatcher = new Dispatcher({
      queue: this.services.jobs,
      now: this.clock.now,
      logger: capturingLogger(this.logs),
    });
    for (const type of [
      ...this.services.engine.jobTypes(),
      ...this.services.inbox.jobTypes(),
      ...this.services.replies.jobTypes(),
      ...this.services.classifier.jobTypes(),
      ...this.services.research.jobTypes(),
      ...this.services.signInChecks.jobTypes(),
    ]) {
      this.dispatcher.register(type);
    }
    this.dispatcher.start();
    this.dispatcher.pause();
    this.services.engine.resync();
    this.services.inbox.resync();
    this.services.research.resync();
  }

  run = () => this.dispatcher.runDue();

  async campaignTo(email: string): Promise<{ campaign: string; accountId: string }> {
    const accountId = (await this.services.accounts.connectImap(imapInput(), ctx())).id;
    const config: CampaignConfigInput = {
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

/** A raw inbound message; `inReplyTo` threads it to one of ours. */
export function inbound(o: {
  from: string;
  subject?: string;
  body?: string;
  inReplyTo?: string;
  headers?: string;
  id?: string;
}): string {
  return [
    `From: ${o.from}`,
    'To: me@acme.test',
    `Subject: ${o.subject ?? 'Re: Hi'}`,
    `Message-ID: <${o.id ?? uuidv7()}@remote.test>`,
    o.inReplyTo ? `In-Reply-To: ${o.inReplyTo}\nReferences: ${o.inReplyTo}` : null,
    o.headers ?? null,
    'Date: Mon, 28 Sep 2026 12:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body ?? 'Thanks, interested.',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}
