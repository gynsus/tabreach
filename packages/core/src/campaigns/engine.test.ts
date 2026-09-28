import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { RpcError, silentLogger, uuidv7, type CampaignConfig, type CampaignStep } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppServices } from '../app-handlers.js';
import type { OutgoingMessage } from '../channels/channel.js';
import { TestChannel } from '../channels/test-channel.js';
import { openDatabase } from '../db/database.js';
import { migrate } from '../db/migrate.js';
import { migrations } from '../db/migrations.js';
import { fakeClock } from '../db/test-db.js';
import { Dispatcher } from '../jobs/dispatcher.js';

const DAY = 24 * 60 * 60_000;
const ctx = () => ({ correlationId: uuidv7() });

const message = (over: Partial<Extract<CampaignStep, { type: 'send_message' }>> = {}): CampaignStep => ({
  type: 'send_message',
  channel: 'test',
  executionMode: 'auto',
  delaySeconds: 0,
  subject: 'Hello {{firstName}}',
  body: 'Hi {{firstName}}, a note for {{companyName|your team}}.',
  ...over,
});

const config = (steps: CampaignStep[], over: Partial<CampaignConfig> = {}): CampaignConfig => ({
  steps,
  timezone: 'UTC',
  window: null,
  approvalMode: 'approve_each',
  emailAccountId: null,
  ...over,
});

/** A core without Electron: services, a test channel and a dispatcher driven by hand. */
class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'tabreach-campaigns-'));
  readonly clock = fakeClock('2026-09-28T10:00:00.000Z'); // Monday
  db!: DatabaseSync;
  services!: AppServices;
  channel!: TestChannel;
  dispatcher!: Dispatcher;

  async open(): Promise<this> {
    this.db = openDatabase(join(this.dir, 'app.db'));
    await migrate(this.db, migrations, { backupDir: join(this.dir, 'backups') });
    this.boot();
    return this;
  }

  /** A fresh core process on the same database: new services, new dispatcher owner. */
  boot(channelSpacingMs = 0): void {
    this.channel = new TestChannel(this.db, this.clock.now, channelSpacingMs);
    this.services = new AppServices(this.db, { now: this.clock.now, channels: [this.channel] });
    this.dispatcher = new Dispatcher({
      queue: this.services.jobs,
      now: this.clock.now,
      logger: silentLogger,
    });
    for (const type of this.services.engine.jobTypes()) this.dispatcher.register(type);
    this.dispatcher.start();
    this.dispatcher.pause(); // no timers: tests drive it with runDue()
    this.services.engine.resync();
  }

  run(): Promise<void> {
    return this.dispatcher.runDue();
  }

  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.run();
  }

  contact(firstName: string, email: string, company?: { name: string; website?: string }): string {
    const companyId = company ? this.services.prospects.createCompany(company, ctx()).id : null;
    return this.services.prospects.createContact({ firstName, email, companyId }, ctx()).id;
  }

  launch(steps: CampaignStep[], over: Partial<CampaignConfig> = {}): string {
    const { campaigns } = this.services;
    const id = campaigns.create({ name: 'Test', config: config(steps, over) }, ctx()).id;
    campaigns.launch(id, ctx());
    return id;
  }

  pending() {
    return this.services.approvals.pending();
  }

  async approveAll(): Promise<void> {
    for (const a of this.pending()) this.services.approvals.approve(a.id, a.contentHash, ctx());
    await this.run();
  }

  enrollments(campaignId: string) {
    return this.services.campaigns.listEnrollments(campaignId, { limit: 100, offset: 0 }).items;
  }

  close(): void {
    this.dispatcher.stop();
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

describe('campaign engine', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  it('runs a two-step campaign over several prospects with delays and approvals', async () => {
    const ann = h.contact('Ann', 'ann@acme.test', { name: 'Acme', website: 'acme.test' });
    const bob = h.contact('Bob', 'bob@beta.test');
    const eve = h.contact('Eve', 'eve@gamma.test');
    const campaign = h.launch([
      message(),
      message({ delaySeconds: 3 * 24 * 60 * 60, subject: 'Re: {{firstName}}' }),
    ]);
    expect(h.services.campaigns.enroll(campaign, [ann, bob, eve, ann], ctx())).toEqual({
      enrolled: 3,
      alreadyEnrolled: 0,
      skipped: 0,
      onHold: 0,
    });
    await h.run();

    const first = h.pending();
    expect(first.map((a) => a.contactName)).toEqual(['Ann', 'Bob', 'Eve']);
    expect(first[0]).toMatchObject({
      subject: 'Hello Ann',
      body: 'Hi Ann, a note for Acme.',
      target: 'ann@acme.test',
    });
    expect(first[1]?.body).toBe('Hi Bob, a note for your team.');
    expect(h.channel.deliveries()).toHaveLength(0); // nothing leaves before approval

    await h.approveAll();
    expect(h.channel.deliveries().map((d) => d.subject)).toEqual(['Hello Ann', 'Hello Bob', 'Hello Eve']);
    expect(h.enrollments(campaign).every((e) => e.stepPosition === 2 && e.waiting === 'schedule')).toBe(true);

    await h.advance(2 * DAY);
    expect(h.pending()).toHaveLength(0); // the delay is not over yet
    await h.advance(DAY);
    expect(h.pending()).toHaveLength(3);
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(6);
    expect(h.enrollments(campaign).map((e) => e.status)).toEqual(['completed', 'completed', 'completed']);
    expect(h.services.campaigns.get(campaign).enrollments.completed).toBe(3);
  });

  it('resumes after a restart', async () => {
    // Follow-ups are touches too: the default cap is 1 per contact per 3 days.
    const campaign = h.launch([message(), message({ delaySeconds: 3 * 24 * 60 * 60 })]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(1);

    h.dispatcher.stop();
    h.clock.advance(3 * DAY);
    h.boot(); // app restarted while the delay ran out
    await h.run();
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(2);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('a crash after delivery but before the result is recorded does not send twice', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    const [approval] = h.pending();
    h.channel.force('hang_after_delivery');
    h.services.approvals.approve(approval?.id as string, approval?.contentHash as string, ctx());
    void h.run(); // core "dies" inside the send
    await new Promise((r) => setImmediate(r));
    expect(h.db.prepare('SELECT status FROM side_effects').all()).toEqual([{ status: 'executing' }]);

    h.boot(); // new core instance takes over the orphaned job
    await h.run();
    expect(h.channel.deliveries()).toHaveLength(1);
    expect(h.db.prepare('SELECT status, reconciled_by FROM side_effects').all()).toEqual([
      { status: 'completed', reconciled_by: 'provider_lookup' },
    ]);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('an unconfirmed send is reconciled on retry, never re-sent', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    h.channel.force('unknown');
    await h.approveAll();
    expect(h.db.prepare('SELECT status FROM side_effects').all()).toEqual([{ status: 'unknown' }]);
    expect(h.enrollments(campaign)[0]?.waiting).toBe('retry');

    await h.advance(60_000);
    expect(h.channel.deliveries()).toHaveLength(1);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('a rejected send is retried and sent once', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    h.channel.force('not_sent');
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(0);
    await h.advance(60_000);
    expect(h.channel.deliveries()).toHaveLength(1);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('an edited draft invalidates the approval', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    const [old] = h.pending();
    if (!old) throw new Error('no approval');

    const revised = h.services.approvals.revise(old.draftId, 'Hello Ann', 'Edited body', ctx());
    expect(revised.draftVersion).toBe(2);
    expect(revised.contentHash).not.toBe(old.contentHash);
    expect(() => h.services.approvals.approve(old.id, old.contentHash, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ code: 'CONFLICT', detail: 'approval.notPending' }),
      }),
    );
    expect(() => h.services.approvals.approve(revised.id, old.contentHash, ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ code: 'APPROVAL_STALE' }) }),
    );
    expect(h.pending().map((a) => a.id)).toEqual([revised.id]);

    await h.approveAll();
    expect(h.channel.deliveries().map((d) => d.body)).toEqual(['Edited body']);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('a changed recipient after approval asks for approval again', async () => {
    const campaign = h.launch([message()]);
    const ann = h.contact('Ann', 'ann@acme.test');
    h.services.campaigns.enroll(campaign, [ann], ctx());
    await h.run();
    const [approval] = h.pending();
    // Approved, then the email changes before the run gets to send.
    h.services.approvals.approve(approval?.id as string, approval?.contentHash as string, ctx());
    h.services.prospects.updateContact({ id: ann, firstName: 'Ann', email: 'ann@new.test' }, ctx());
    await h.run();
    expect(h.channel.deliveries()).toHaveLength(0);
    const [again] = h.pending();
    expect(again?.target).toBe('ann@new.test');
    await h.approveAll();
    expect(h.channel.deliveries().map((d) => d.target)).toEqual(['ann@new.test']);
  });

  it('a suppressed contact is blocked at send time, including by a parent domain', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@mail.acme.test')], ctx());
    await h.run();
    const [approval] = h.pending();
    h.services.approvals.approve(approval?.id as string, approval?.contentHash as string, ctx());
    h.services.suppressions.add('domain', 'acme.test', ctx()); // after approval, before the send
    await h.run();
    expect(h.channel.deliveries()).toHaveLength(0);
    expect(h.enrollments(campaign)[0]).toMatchObject({ status: 'stopped', stopReason: 'suppressed' });
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM side_effects').get()).toEqual({ n: 0 });
  });

  it('waits for the active window in the recipient zone', async () => {
    h.clock.set('2026-10-03T12:00:00.000Z'); // Saturday
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    expect(h.pending()).toHaveLength(0);
    expect(h.enrollments(campaign)[0]).toMatchObject({
      nextActionAt: '2026-10-05T09:00:00.000Z',
      waiting: 'schedule',
    });
    h.clock.set('2026-10-05T09:00:00.000Z');
    await h.run();
    expect(h.pending()).toHaveLength(1);
  });

  it('caps touches per contact across campaigns', async () => {
    const ann = h.contact('Ann', 'ann@acme.test');
    const one = h.launch([message()]);
    const two = h.launch([message({ subject: 'Other' })]);
    h.services.campaigns.enroll(one, [ann], ctx());
    await h.run();
    await h.approveAll();
    h.services.campaigns.enroll(two, [ann], ctx());
    await h.run();
    expect(h.pending()).toHaveLength(0); // 1 touch per 3 days
    expect(h.enrollments(two)[0]?.waiting).toBe('schedule');
    await h.advance(3 * DAY);
    expect(h.pending()).toHaveLength(1);
  });

  it('spaces sends through a channel account', async () => {
    h.dispatcher.stop();
    h.boot(60_000);
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(
      campaign,
      [h.contact('Ann', 'ann@a.test'), h.contact('Bob', 'bob@b.test')],
      ctx(),
    );
    await h.run();
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(1);
    await h.advance(59_000);
    expect(h.channel.deliveries()).toHaveLength(1);
    await h.advance(1_000);
    expect(h.channel.deliveries()).toHaveLength(2);
  });

  it('reject stops the enrollment; skip moves on to the next step', async () => {
    const campaign = h.launch([message(), message({ subject: 'Second' })]);
    h.services.campaigns.enroll(
      campaign,
      [h.contact('Ann', 'ann@a.test'), h.contact('Bob', 'bob@b.test')],
      ctx(),
    );
    await h.run();
    const [ann, bob] = h.pending();
    h.services.approvals.reject(ann?.id as string, ctx());
    h.services.approvals.skip(bob?.id as string, ctx());
    await h.run();
    const [a, b] = h.enrollments(campaign);
    expect(a).toMatchObject({ status: 'stopped', stopReason: 'rejected' });
    expect(b).toMatchObject({ status: 'active', stepPosition: 2 });
    expect(h.pending().map((p) => p.subject)).toEqual(['Second']);
    expect(h.channel.deliveries()).toHaveLength(0);
  });

  it('a failed condition with "skip" leaves out the step it guards and continues after it', async () => {
    const campaign = h.launch([
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'contact.jobTitle', op: 'exists' }],
        onFalse: 'skip',
      },
      message({ subject: 'Only for people with a title' }),
      message({ subject: 'For everyone' }),
    ]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    expect(h.pending().map((a) => a.subject)).toEqual(['For everyone']);
  });

  it('condition steps stop or skip', async () => {
    const campaign = h.launch([
      {
        type: 'condition',
        delaySeconds: 0,
        conditions: [{ field: 'contact.email', op: 'contains', value: '@acme' }],
        onFalse: 'stop',
      },
      message(),
    ]);
    h.services.campaigns.enroll(
      campaign,
      [h.contact('Ann', 'ann@acme.test'), h.contact('Bob', 'bob@b.test')],
      ctx(),
    );
    await h.run();
    const [ann, bob] = h.enrollments(campaign);
    expect(ann).toMatchObject({ status: 'active', stepPosition: 2, waiting: 'approval' });
    expect(bob).toMatchObject({ status: 'stopped', stopReason: 'condition_not_met' });
  });

  it('pausing the campaign holds sends until it resumes', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    const [approval] = h.pending();
    h.services.campaigns.pause(campaign, ctx());
    h.services.approvals.approve(approval?.id as string, approval?.contentHash as string, ctx());
    await h.run();
    expect(h.channel.deliveries()).toHaveLength(0);
    h.services.campaigns.resume(campaign, ctx());
    await h.run();
    expect(h.channel.deliveries()).toHaveLength(1);
  });

  it('stopping an enrollment closes its pending approval', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    const [e] = h.enrollments(campaign);
    h.services.campaigns.stopEnrollment(e?.id as string, ctx());
    expect(h.pending()).toHaveLength(0);
    expect(h.db.prepare('SELECT status FROM approvals').all()).toEqual([{ status: 'expired' }]);
    expect(h.db.prepare('SELECT status FROM workflow_runs').all()).toEqual([{ status: 'cancelled' }]);
  });

  it('stops enrollments whose template data is missing', async () => {
    const campaign = h.launch([message({ body: 'Hi {{jobTitle}}' })]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    expect(h.enrollments(campaign)[0]).toMatchObject({ status: 'stopped', stopReason: 'missing_data' });
  });

  it('validates a campaign before launch', () => {
    const { campaigns } = h.services;
    const id = campaigns.create(
      { name: 'Bad', config: config([message({ body: 'Hi {{nickname}}' })], { timezone: 'Mars/Olympus' }) },
      ctx(),
    ).id;
    try {
      campaigns.launch(id, ctx());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).problem.fields).toEqual({
        timezone: 'timezone.invalid',
        'steps.0.body': 'template.unknownField',
      });
    }
    const empty = campaigns.create({ name: 'Empty' }, ctx()).id;
    expect(() => campaigns.launch(empty, ctx())).toThrow(RpcError);
    expect(() => campaigns.enroll(empty, [uuidv7()], ctx())).toThrow(/current state/);
  });

  it('keeps running enrollments on their version after a relaunch', async () => {
    const campaign = h.launch([message({ subject: 'v1' })]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@a.test')], ctx());
    h.services.campaigns.update({ id: campaign, config: config([message({ subject: 'v2' })]) }, ctx());
    h.services.campaigns.launch(campaign, ctx());
    h.services.campaigns.enroll(campaign, [h.contact('Bob', 'bob@b.test')], ctx());
    await h.run();
    expect(h.pending().map((a) => a.subject)).toEqual(['v1', 'v2']);
    expect(h.enrollments(campaign).map((e) => e.version)).toEqual([1, 2]);
  });
});

describe('audit 3.5: send safety', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  const effect = () =>
    h.db.prepare('SELECT id, status, target_normalized FROM side_effects ORDER BY created_at DESC').get() as {
      id: string;
      status: string;
      target_normalized: string;
    };

  /** An attempt that ended unknown and that reconciliation cannot settle (nothing was delivered). */
  async function unknownAttempt(email = 'ann@acme.test') {
    const campaign = h.launch([message()]);
    const contactId = h.contact('Ann', email);
    h.services.campaigns.enroll(campaign, [contactId], ctx());
    await h.run();
    h.channel.force('hang_before_delivery');
    h.channel.reconcile = async () => ({ status: 'unknown' });
    for (const a of h.pending()) h.services.approvals.approve(a.id, a.contentHash, ctx());
    void h.run();
    await new Promise((r) => setImmediate(r));
    h.boot(); // crash while sending; the new core finds it `executing`
    h.channel.reconcile = async () => ({ status: 'unknown' });
    await h.run();
    return { campaign, contactId };
  }

  it('refuses a person’s decision while a send job is still checking; lists the attempt meanwhile', async () => {
    await unknownAttempt();
    expect(effect().status).toBe('unknown');
    expect(h.services.uncertainSends()).toMatchObject([{ target: 'ann@acme.test', checking: true }]);
    expect(() => h.services.resolveSideEffect(effect().id, 'not_sent', 'c')).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'sideEffect.busy' }) }),
    );
  });

  it('a ledger row changed while the channel was sending fails permanently instead of retrying', async () => {
    const campaign = h.launch([message()]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    const send = h.channel.send.bind(h.channel);
    h.channel.send = async (m: OutgoingMessage) => {
      const result = await send(m);
      h.services.ledger.markNotSent(effect().id, 'someone_else', 'user_confirmation'); // the race
      return result;
    };
    await h.approveAll();
    const [job] = h.services.jobs.needsAttention();
    expect(job).toMatchObject({ status: 'failed', last_error_class: 'ledger_conflict' });
    await h.advance(60 * 60_000);
    expect(h.channel.deliveries()).toHaveLength(1); // never a second one
  });

  it('a stop that arrives while reconciliation awaits is respected', async () => {
    const { campaign } = await unknownAttempt();
    const [e] = h.enrollments(campaign);
    h.channel.reconcile = async () => {
      h.services.campaigns.stopEnrollment(e!.id, ctx()); // e.g. a reply ingested meanwhile
      return { status: 'not_sent' };
    };
    await h.advance(60 * 60_000);
    expect(h.channel.deliveries()).toHaveLength(0);
    expect(h.enrollments(campaign)[0]?.status).toBe('stopped');
  });

  it('a new address after an unknown attempt waits for a person; "it was sent" completes the step', async () => {
    const { campaign, contactId } = await unknownAttempt();
    h.services.prospects.updateContact({ id: contactId, firstName: 'Ann', email: 'ann@new.test' }, ctx());
    h.channel.reconcile = async () => ({ status: 'unknown' });
    for (let i = 0; i < 8; i++) await h.advance(60 * 60_000);
    const pending = h.services.approvals.pending();
    for (const a of pending) h.services.approvals.approve(a.id, a.contentHash, ctx());
    await h.advance(60 * 60_000);
    expect(h.channel.deliveries().filter((d) => d.target === 'ann@new.test')).toHaveLength(0);
    const [uncertain] = h.services.uncertainSends();
    expect(uncertain).toMatchObject({ target: 'ann@acme.test', checking: false });
    h.services.resolveSideEffect(uncertain!.id, 'completed', 'c');
    for (const job of h.services.jobs.needsAttention()) h.services.jobs.requeue(job.id);
    await h.advance(60 * 60_000);
    expect(h.channel.deliveries()).toHaveLength(0);
    expect(h.enrollments(campaign)[0]?.status).toBe('completed');
  });

  it('a restart does not revive a send job that died; it waits in Needs attention', async () => {
    await unknownAttempt();
    for (let i = 0; i < 8; i++) await h.advance(60 * 60_000);
    expect(h.services.jobs.needsAttention()).toHaveLength(1);
    h.boot();
    await h.advance(60 * 60_000);
    const active = h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE type = 'workflow.run' AND status IN ('pending', 'running')`,
      )
      .get();
    expect(active).toEqual({ n: 0 });
  });

  it('launching changes of a paused campaign keeps it paused', async () => {
    const campaign = h.launch([message({ subject: 'v1' })]);
    h.services.campaigns.enroll(campaign, [h.contact('Ann', 'ann@acme.test')], ctx());
    await h.run();
    h.services.campaigns.pause(campaign, ctx());
    h.services.campaigns.update({ id: campaign, config: config([message({ subject: 'v2' })]) }, ctx());
    expect(h.services.campaigns.launch(campaign, ctx()).status).toBe('paused');
    await h.approveAll();
    expect(h.channel.deliveries()).toHaveLength(0);
  });
});
