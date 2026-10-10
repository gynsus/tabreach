import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, Harness, inbound } from './harness.js';

/** Replies written and sent from the inbox (ADR 031, docs/01 "Inbox"). */
describe('replies from the inbox', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await new Harness().open();
  });
  afterEach(() => h.close());

  /** Bob got the campaign email and answered it; returns his conversation. */
  async function bobReplied() {
    const { campaign } = await h.campaignTo('bob@beta.test');
    h.approve();
    await h.run();
    const first = h.mail.delivered[0]!.messageId;
    h.mail.receive(
      inbound({
        from: 'Bob Lee <bob@beta.test>',
        subject: 'Re: Hi Bob',
        inReplyTo: first,
        id: 'bob-1',
        body: 'Tell me more.',
      }),
    );
    h.clock.advance(2 * 60_000);
    await h.run();
    // Past the reply's Date header (12:00), so the thread reads in order.
    h.clock.advance(3 * 60 * 60_000);
    const [summary] = h.services.inbox.list('all', { limit: 10, offset: 0 }).items;
    const conversation = h.services.replies.forConversation(summary!.id);
    return { campaign, first, conversationId: summary!.id, target: conversation.replyTarget! };
  }
  const outbound = () => h.mail.delivered.slice(1);
  const reply = (conversationId: string, messageId: string, body = 'Happy to. Does Thursday work?') =>
    h.services.replies.send({ conversationId, messageId, subject: 'Re: Hi Bob', body }, ctx());

  it('answers the latest reply in its thread, through the ledger, and shows it in the conversation', async () => {
    const { first, conversationId, target } = await bobReplied();
    expect(target).toEqual({
      messageId: expect.any(String),
      address: 'bob@beta.test',
      subject: 'Re: Hi Bob',
    });

    const sending = reply(conversationId, target.messageId);
    expect(sending).toMatchObject({ status: 'sending', to: 'bob@beta.test' });
    // One at a time: a second reply while the first is on its way is refused.
    expect(() => reply(conversationId, target.messageId, 'Again')).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'reply.pending' }) }),
    );
    await h.run();

    const [sent] = outbound();
    expect(sent!.to).toBe('bob@beta.test');
    const headers = sent!.raw.replace(/\r?\n[ \t]+/g, ' '); // unfolded
    expect(headers).toMatch(/^In-Reply-To: <bob-1@remote\.test>/m);
    expect(headers).toContain(`References: ${first} <bob-1@remote.test>`);
    expect(headers).toMatch(/^Subject: Re: Hi Bob/m);
    expect(h.db.prepare(`SELECT status, action_type FROM side_effects ORDER BY created_at`).all()).toEqual([
      { status: 'completed', action_type: 'send_message' },
      { status: 'completed', action_type: 'email.reply' },
    ]);
    const thread = {
      ...h.services.inbox.get(conversationId),
      ...h.services.replies.forConversation(conversationId),
    };
    expect(thread.replies).toEqual([]);
    expect(thread.messages.map((m) => [m.direction, m.body])).toEqual([
      ['outbound', 'Hello Bob'],
      ['inbound', 'Tell me more.'],
      ['outbound', 'Happy to. Does Thursday work?'],
    ]);
    expect(
      h.db
        .prepare(
          `SELECT status FROM action_events WHERE action_type = 'message.reply' ORDER BY created_at, id`,
        )
        .all()
        .map((r) => (r as { status: string }).status),
    ).toEqual(['planned', 'completed']);
    // Running again sends nothing more.
    h.clock.advance(60 * 60_000);
    await h.run();
    expect(outbound()).toHaveLength(1);

    // Bob's answer to the reply matches by thread.
    h.mail.receive(inbound({ from: 'bob@beta.test', inReplyTo: sent!.messageId, body: 'Thursday is fine.' }));
    h.clock.advance(2 * 60_000);
    await h.run();
    expect(h.services.inbox.get(conversationId).messages).toContainEqual(
      expect.objectContaining({ direction: 'inbound', body: 'Thursday is fine.', matchStrength: 'thread' }),
    );
  });

  it('the do-not-contact list stops a reply when it is written and when it would go out', async () => {
    const { conversationId, target } = await bobReplied();
    h.services.suppressions.add('domain', 'beta.test', ctx());
    expect(() => reply(conversationId, target.messageId)).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'reply.suppression.domain' }) }),
    );
    const id = h.db.prepare('SELECT id FROM suppressions').get() as { id: string };
    h.services.suppressions.remove(id.id, ctx());

    reply(conversationId, target.messageId);
    // Bob opts out before the send runs.
    h.services.suppressions.add('email', 'bob@beta.test', ctx());
    await h.run();
    expect(outbound()).toHaveLength(0);
    expect(h.services.replies.forConversation(conversationId).replies).toMatchObject([
      { status: 'failed', errorClass: 'suppression.email' },
    ]);
  });

  it('while everything is paused a reply is refused; a failed one can be sent again', async () => {
    const { conversationId, target } = await bobReplied();
    h.services.appControl.pauseAll(ctx());
    expect(() => reply(conversationId, target.messageId)).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'reply.paused' }) }),
    );
    h.services.appControl.resumeAll(ctx());

    // The server refuses the recipient before taking the message: verified not sent.
    h.mail.queue({ error: { code: 'EENVELOPE', responseCode: 550, stage: 'submit' } as never });
    const sent = reply(conversationId, target.messageId);
    await h.run();
    expect(h.services.replies.forConversation(conversationId).replies).toMatchObject([
      { id: sent.id, status: 'failed', errorClass: expect.any(String) },
    ]);
    expect(h.services.replies.retry(sent.id, ctx())).toMatchObject({ status: 'sending' });
    await h.run();
    expect(outbound()).toHaveLength(1);
    expect(h.services.replies.forConversation(conversationId).replies).toEqual([]);
    expect(() => h.services.replies.retry(sent.id, ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'reply.notFailed' }) }),
    );
  });

  it('an uncertain reply is never sent again by itself; the person settles it under Needs attention', async () => {
    const { conversationId, target } = await bobReplied();
    // The connection drops after submitting: it may or may not have gone out.
    h.mail.queue({ error: { code: 'ECONNECTION', stage: 'submit' } as never });
    const sent = reply(conversationId, target.messageId);
    await h.run();
    expect(h.services.replies.forConversation(conversationId).replies).toMatchObject([{ status: 'unknown' }]);
    // A new reply in the same conversation waits until this one is settled.
    expect(() => reply(conversationId, target.messageId, 'Hello?')).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'reply.pending' }) }),
    );
    for (let i = 0; i < 8; i++) {
      h.clock.advance(60 * 60_000);
      await h.run();
    }
    expect(outbound()).toHaveLength(0);

    const [uncertain] = h.services.uncertainSends();
    expect(uncertain).toMatchObject({
      source: 'reply',
      contactName: 'Bob Lee',
      campaignName: null,
      target: 'bob@beta.test',
      checking: false,
    });
    h.services.resolveSideEffect(uncertain!.id, 'completed', 'c');
    expect(h.services.replies.forConversation(conversationId).replies).toEqual([]);
    expect(h.services.inbox.get(conversationId).messages.at(-1)).toMatchObject({
      direction: 'outbound',
      body: 'Happy to. Does Thursday work?',
    });
    expect(h.services.uncertainSends()).toEqual([]);
    expect(sent.status).toBe('sending');
  });

  it('a person can say an uncertain reply did not go out; then it can be sent again', async () => {
    const { conversationId, target } = await bobReplied();
    h.mail.queue({ error: { code: 'ECONNECTION', stage: 'submit' } as never });
    const sent = reply(conversationId, target.messageId);
    await h.run();
    // While its job is still checking, deciding is refused.
    const [uncertain] = h.services.uncertainSends();
    expect(uncertain).toMatchObject({ checking: true });
    expect(() => h.services.resolveSideEffect(uncertain!.id, 'not_sent', 'c')).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'sideEffect.busy' }) }),
    );
    for (let i = 0; i < 8; i++) {
      h.clock.advance(60 * 60_000);
      await h.run();
    }
    h.services.resolveSideEffect(uncertain!.id, 'not_sent', 'c');
    expect(h.services.replies.forConversation(conversationId).replies).toMatchObject([
      { status: 'failed', errorClass: 'user_confirmed_not_sent' },
    ]);
    h.services.replies.retry(sent.id, ctx());
    await h.run();
    expect(outbound()).toHaveLength(1);
  });
});
