import type {
  CampaignConfigInput,
  LinkedinSettings,
  RequestOf,
  RequestType,
  ResponseOf,
  TaskResult,
  ThreadReadResult,
} from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness } from '../email/harness.js';

/** What the LinkedIn page shows next: an action's outcome, or the conversation. */
type Page = 'ok' | 'pending' | 'connectable' | 'someone_else' | 'replied';

describe('LinkedIn as a campaign channel (Phase 7b)', () => {
  let h: Harness;
  const pages: Page[] = [];
  const calls: { type: string; payload: unknown }[] = [];
  const worker = {
    request<T extends RequestType>(type: T, payload: RequestOf<T>): Promise<ResponseOf<T>> {
      calls.push({ type, payload });
      if (type === 'profile.open')
        return Promise.resolve({ chromeVersion: '140', currentUrl: null } as ResponseOf<T>);
      const next = pages[0] ?? 'ok';
      if (type === 'thread.read') {
        if (next === 'replied' || next === 'connectable') pages.shift();
        const thread: ThreadReadResult = {
          status: next === 'connectable' ? 'unsupported_state' : 'ok',
          messages: next === 'replied' ? [{ direction: 'out' }, { direction: 'in' }] : [{ direction: 'out' }],
          replied: next === 'replied',
          stateId: next === 'connectable' ? 'linkedin.profile.connectable' : 'linkedin.composer',
          packVersion: '0.2.0',
          errorKey: null,
          diagnostics: null,
        };
        return Promise.resolve(thread as ResponseOf<T>);
      }
      if (type === 'task.run') {
        pages.shift();
        const req = payload as RequestOf<'task.run'>;
        const base: TaskResult = {
          status: 'succeeded',
          stateId: null,
          stateKind: null,
          packVersion: '0.2.0',
          url: req.url,
          diagnostics: null,
          errorKey: null,
          committed: false,
        };
        if (next === 'pending')
          return Promise.resolve({
            ...base,
            status: 'unsupported_state',
            stateId: 'linkedin.profile.pending',
          } as ResponseOf<T>);
        if (next === 'someone_else')
          return Promise.resolve({
            ...base,
            status: 'unsupported_state',
            errorKey: 'task.identityMismatch',
          } as ResponseOf<T>);
        const { proceed } = h.services.checkpoints.reach({ taskId: req.taskId, phase: 'about_to_commit' });
        if (!proceed)
          return Promise.resolve({
            ...base,
            status: 'failed',
            errorKey: 'task.checkpointRefused',
          } as ResponseOf<T>);
        return Promise.resolve({
          ...base,
          status: 'succeeded',
          stateId: 'linkedin.invite.sent',
          committed: true,
        } as ResponseOf<T>);
      }
      return Promise.resolve({ ok: true } as ResponseOf<T>);
    },
  };
  beforeEach(async () => {
    h = await new Harness().open();
    h.worker = worker;
    pages.length = 0;
    calls.length = 0;
    profileId = '';
  });
  afterEach(() => h.close());

  const s = () => h.services;
  let profileId = '';
  const account = (over: Partial<LinkedinSettings & { acknowledgeRisk: boolean }> = {}) => {
    profileId ||= s().browser.create({ name: 'LinkedIn', purpose: 'general' }, ctx()).id;
    return s().linkedin.update(
      {
        enabled: true,
        profileId,
        acknowledgeRisk: true,
        autoConnect: false,
        autoMessage: false,
        limits: { connectPerDay: 15, connectPerWeek: 80, messagePerDay: 30 },
        limitsRaised: false,
        ...over,
      },
      ctx(),
    );
  };
  const config = (steps: Partial<CampaignConfigInput['steps'][number]>[]): CampaignConfigInput => ({
    steps: steps.map(
      (over) =>
        ({
          type: 'send_message',
          channel: 'linkedin',
          linkedinAction: 'connect',
          executionMode: 'assisted',
          delaySeconds: 0,
          subject: '',
          body: 'Hi {{firstName}}, glad to connect.',
          ...over,
        }) as CampaignConfigInput['steps'][number],
    ),
    timezone: 'UTC',
    window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
    approvalMode: 'approve_each',
  });
  const start = async (
    steps: Partial<CampaignConfigInput['steps'][number]>[] = [{}],
    people = [['Ann', 'Lee', 'ann-lee']],
  ) => {
    const campaign = s().campaigns.create({ name: 'LinkedIn', config: config(steps) }, ctx()).id;
    s().campaigns.launch(campaign, ctx());
    const ids = people.map(
      ([firstName, lastName, slug]) =>
        s().prospects.createContact(
          { firstName, lastName, linkedinUrl: `https://www.linkedin.com/in/${slug}/` },
          ctx(),
        ).id,
    );
    s().campaigns.enroll(campaign, ids, ctx());
    await h.run();
    return campaign;
  };
  const runs = () =>
    calls.filter((c) => c.type === 'task.run').map((c) => c.payload as RequestOf<'task.run'>);
  const approveAll = async () => {
    h.approve();
    await h.run();
  };

  it('is off until turned on with the risk acknowledged; off again, nothing is sent (fails closed)', async () => {
    const campaign = s().campaigns.create({ name: 'L', config: config([{}]) }, ctx()).id;
    expect(() => s().campaigns.launch(campaign, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.channel': 'linkedin.disabled' } }),
      }),
    );
    profileId = s().browser.create({ name: 'LinkedIn', purpose: 'general' }, ctx()).id;
    expect(() => account({ acknowledgeRisk: false })).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { acknowledgeRisk: 'linkedin.riskRequired' } }),
      }),
    );
    account();
    await start();
    account({ enabled: false });
    await approveAll();
    expect(runs()).toEqual([]);
    expect(h.ledger()).toEqual([]);
  });

  it('invites in assisted mode by default, with the note, checking the person', async () => {
    account();
    const campaign = await start();
    const [approval] = s().approvals.pending();
    expect(approval).toMatchObject({
      channel: 'linkedin',
      target: 'https://www.linkedin.com/in/ann-lee/',
      subject: null,
    });
    await approveAll();
    expect(runs()).toEqual([
      expect.objectContaining({
        actionId: 'linkedin.connect.note',
        params: { note: 'Hi Ann, glad to connect.' },
        mode: 'assisted',
        identity: { profileUrl: 'https://www.linkedin.com/in/ann-lee/', name: 'Ann Lee' },
      }),
    ]);
    expect(h.ledger()).toMatchObject([{ status: 'completed' }]);
    expect(h.status(campaign)).toMatchObject({ status: 'completed' });
    const attempts = h.db.prepare(`SELECT adapter_pack_id, adapter_pack_version FROM browser_tasks`).all();
    expect(attempts).toEqual([{ adapter_pack_id: 'linkedin', adapter_pack_version: '0.4.0' }]);
  });

  it('auto only where opted in, per action class (FR-LIN-002)', async () => {
    account();
    const campaign = s().campaigns.create(
      { name: 'A', config: config([{ executionMode: 'auto' }]) },
      ctx(),
    ).id;
    expect(() => s().campaigns.launch(campaign, ctx())).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { 'steps.0.executionMode': 'linkedin.autoNotAllowed' } }),
      }),
    );
    account({ autoConnect: true });
    await start([{ executionMode: 'auto' }]);
    await approveAll();
    expect(runs()[0]).toMatchObject({ mode: 'auto' });
  });

  it('before a follow-up the conversation is read: an answer stops it, nothing is sent (FR-LIN-004)', async () => {
    account();
    const campaign = await start([{}, { linkedinAction: 'message', body: 'Following up.' }]);
    await approveAll();
    pages.push('replied');
    h.clock.advance(3 * 24 * 60 * 60_000); // past the contact policy's gap between messages
    await h.run();
    await approveAll();
    expect(calls.map((c) => c.type)).toContain('thread.read');
    expect(runs()).toHaveLength(1); // the invitation only
    expect(h.status(campaign)).toMatchObject({ status: 'stopped', stopReason: 'replied' });
    const reply = h.db
      .prepare(`SELECT COUNT(*) AS n FROM action_events WHERE action_type = 'linkedin.reply_detected'`)
      .get();
    expect(reply).toEqual({ n: 1 });
  });

  it('their unanswered message from before the campaign is no reply, and is not written over', async () => {
    account();
    pages.push('replied');
    const campaign = await start([{ linkedinAction: 'message', body: 'Hello.' }]);
    await approveAll();
    expect(runs()).toEqual([]);
    expect(h.status(campaign)).toMatchObject({ status: 'stopped', stopReason: 'unanswered_message' });
    const reply = h.db
      .prepare(`SELECT COUNT(*) AS n FROM action_events WHERE action_type = 'linkedin.reply_detected'`)
      .get();
    expect(reply).toEqual({ n: 0 });
  });

  it('a message waits for the invitation to be accepted, then gives up; an existing invitation is not sent again', async () => {
    account();
    pages.push('connectable');
    const waiting = await start([{ linkedinAction: 'message', body: 'Hello.' }]);
    await approveAll();
    expect(h.status(waiting)).toMatchObject({ status: 'active' });
    for (let day = 0; day < 15; day++) {
      pages.push('connectable');
      h.clock.advance(24 * 60 * 60_000 + 1);
      await h.run();
    }
    expect(h.status(waiting)).toMatchObject({ status: 'stopped', stopReason: 'not_connected' });
    expect(runs()).toEqual([]);

    pages.length = 0;
    pages.push('pending');
    const invited = await start([{}], [['Cara', 'Pending', 'cara-pending']]);
    await approveAll();
    expect(h.status(invited)).toMatchObject({ status: 'completed' });
    expect(h.ledger()).toContainEqual(expect.objectContaining({ status: 'not_sent' }));
  });

  it('a page about someone else stops the enrollment; the daily limit holds the next invitation', async () => {
    account({ limits: { connectPerDay: 1, connectPerWeek: 80, messagePerDay: 30 } });
    pages.push('someone_else');
    const wrong = await start();
    await approveAll();
    expect(h.status(wrong)).toMatchObject({ status: 'stopped', stopReason: 'invalid_target' });
    // The attempt shows in the pack's health: one task, one unrecognized page (FR-LIN-006).
    expect(s().browser.packHealth()).toEqual([
      expect.objectContaining({ packId: 'linkedin', version: '0.4.0', tasks: 1, unsupported: 1 }),
    ]);

    const two = await start(
      [{}],
      [
        ['Dan', 'One', 'dan-one'],
        ['Eve', 'Two', 'eve-two'],
      ],
    );
    await approveAll();
    h.clock.advance(3 * 60_000);
    await h.run();
    expect(runs().filter((r) => r.actionId?.startsWith('linkedin.connect'))).toHaveLength(2); // wrong one + one of two
    expect(
      s()
        .campaigns.listEnrollments(two, { limit: 5, offset: 0 })
        .items.map((i) => i.status)
        .sort(),
    ).toEqual(['active', 'completed']);
  });

  it('raising a limit above the product default needs an explicit acknowledgement (FR-LIN-005)', () => {
    expect(() => account({ limits: { connectPerDay: 50, connectPerWeek: 80, messagePerDay: 30 } })).toThrow(
      expect.objectContaining({
        problem: expect.objectContaining({ fields: { limits: 'linkedin.limitsRaiseRequired' } }),
      }),
    );
    expect(
      account({ limits: { connectPerDay: 50, connectPerWeek: 80, messagePerDay: 30 }, limitsRaised: true }),
    ).toMatchObject({
      limitsRaised: true,
    });
  });
});
