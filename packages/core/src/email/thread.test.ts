import type { CampaignConfigInput, CampaignStep } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness, imapInput, inbound } from './harness.js';

const DAY = 24 * 60 * 60_000;

const email = (over: Partial<Extract<CampaignStep, { type: 'send_message' }>> = {}) => ({
  type: 'send_message' as const,
  channel: 'email' as const,
  executionMode: 'auto' as const,
  delaySeconds: 0,
  subject: 'Hi {{firstName}}',
  body: 'Hello {{firstName}}',
  ...over,
});

/** Follow-ups sent as replies in the thread of the earlier campaign emails (docs/17 `replyAsThread`). */
describe('email follow-ups in the same thread', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  async function start(accountId: string, steps: CampaignStepInput[]): Promise<string> {
    const config: CampaignConfigInput = {
      steps,
      timezone: 'UTC',
      window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
      approvalMode: 'approve_each',
      emailAccountId: accountId,
    };
    const { campaigns, prospects } = h.services;
    const id = campaigns.create({ name: 'Thread', config }, ctx()).id;
    campaigns.launch(id, ctx());
    campaigns.enroll(
      id,
      [prospects.createContact({ firstName: 'Bob', email: 'bob@beta.test' }, ctx()).id],
      ctx(),
    );
    await h.run();
    return id;
  }

  /** Approves whatever waits, sends it, then lets the next step's delay pass. */
  async function step(): Promise<void> {
    h.approve();
    await h.run();
    h.clock.advance(3 * DAY);
    await h.run();
  }

  const header = (raw: string | undefined, name: string) =>
    // Long headers are folded onto continuation lines.
    new RegExp(`^${name}: (.*)$`, 'mi').exec((raw ?? '').replace(/\r?\n[ \t]+/g, ' '))?.[1]?.trim() ?? null;

  it('the follow-up answers the earlier emails: Re: subject, In-Reply-To and References', async () => {
    const account = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    await start(account, [
      email(),
      email({ delaySeconds: 3 * 86_400, subject: 'Ignored', body: 'Following up', replyAsThread: true }),
      email({ delaySeconds: 3 * 86_400, subject: 'Ignored too', body: 'Last note', replyAsThread: true }),
    ]);
    // The approval already shows the subject that goes out.
    expect(h.services.approvals.pending()[0]?.subject).toBe('Hi Bob');
    await step();
    expect(h.services.approvals.pending()[0]?.subject).toBe('Re: Hi Bob');
    await step();
    await step();
    const [first, second, third] = h.mail.delivered;
    expect(h.mail.delivered).toHaveLength(3);
    expect(header(first?.raw, 'In-Reply-To')).toBeNull();
    expect(header(second?.raw, 'Subject')).toBe('Re: Hi Bob');
    expect(header(second?.raw, 'In-Reply-To')).toBe(first?.messageId);
    expect(header(second?.raw, 'References')).toBe(first?.messageId);
    expect(header(third?.raw, 'Subject')).toBe('Re: Hi Bob');
    expect(header(third?.raw, 'In-Reply-To')).toBe(second?.messageId);
    expect(header(third?.raw, 'References')).toBe(`${first?.messageId} ${second?.messageId}`);
  });

  it('without an earlier email that went out, the step sends with its own subject and no thread', async () => {
    const account = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    await start(account, [
      { ...email(), channel: 'test' },
      email({ delaySeconds: 3 * 86_400, subject: 'Own subject', replyAsThread: true }),
    ]);
    await step();
    await step();
    expect(h.mail.delivered).toHaveLength(1);
    expect(header(h.mail.delivered[0]?.raw, 'Subject')).toBe('Own subject');
    expect(header(h.mail.delivered[0]?.raw, 'In-Reply-To')).toBeNull();
  });

  it('a step without the option starts a new conversation', async () => {
    const account = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    await start(account, [email(), email({ delaySeconds: 3 * 86_400, subject: 'Another topic' })]);
    await step();
    await step();
    expect(header(h.mail.delivered[1]?.raw, 'Subject')).toBe('Another topic');
    expect(header(h.mail.delivered[1]?.raw, 'In-Reply-To')).toBeNull();
  });

  it('an answer to the follow-up is matched by the thread and stops the sequence', async () => {
    const account = (await h.services.accounts.connectImap(imapInput(), ctx())).id;
    const campaign = await start(account, [
      email(),
      email({ delaySeconds: 3 * 86_400, body: 'Following up', replyAsThread: true }),
      email({ delaySeconds: 3 * 86_400, body: 'Last note', replyAsThread: true }),
    ]);
    await step();
    await step();
    h.mail.receive(
      inbound({ from: 'robert@elsewhere.test', inReplyTo: h.mail.delivered[1]?.messageId ?? '' }),
    );
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(h.services.campaigns.listEnrollments(campaign, { limit: 1, offset: 0 }).items[0]).toMatchObject({
      status: 'stopped',
      stopReason: 'replied',
    });
  });

  describe('Gmail', () => {
    const connect = () =>
      h.services.accounts.connectGmail(
        { clientId: '123-abc.apps.googleusercontent.com', fromName: 'Me' },
        ctx(),
      );

    it('files the follow-up in the same Gmail thread', async () => {
      const account = (await connect()).id;
      await start(account, [email(), email({ delaySeconds: 3 * 86_400, replyAsThread: true })]);
      await step();
      await step();
      const [first, second] = h.google.sent;
      expect(second?.threadId).toBe(first?.threadId);
      expect(header(second?.raw, 'In-Reply-To')).toBe(first?.messageId);
    });

    it('a thread deleted in Gmail does not block the follow-up: it goes as a new Gmail thread, still threaded by headers', async () => {
      const account = (await connect()).id;
      await start(account, [email(), email({ delaySeconds: 3 * 86_400, replyAsThread: true })]);
      await step();
      h.google.threadsGone = true;
      await step();
      expect(h.google.sent).toHaveLength(2);
      expect(h.google.sent[1]?.threadId).not.toBe(h.google.sent[0]?.threadId);
      expect(header(h.google.sent[1]?.raw, 'In-Reply-To')).toBe(h.google.sent[0]?.messageId);
    });
  });
});

type CampaignStepInput = CampaignConfigInput['steps'][number];
