import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestChannel } from '../channels/test-channel.js';
import { fakeClock, testDatabase } from '../db/test-db.js';
import { executeSideEffect } from './execute.js';
import { intentKey, SideEffectLedger, type IntentParts } from './side-effects.js';

const intent: IntentParts = {
  scopeId: 'enr-1',
  stepPosition: 1,
  channel: 'test',
  actionType: 'send_message',
  target: 'ann@acme.test',
};

describe('intentKey', () => {
  it('is stable and depends on every part of the intent, not on content', () => {
    expect(intentKey(intent)).toBe(intentKey({ ...intent }));
    expect(intentKey(intent)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { scopeId: 'enr-2' },
      { stepPosition: 2 },
      { channel: 'email' },
      { target: 'bob@acme.test' },
    ]) {
      expect(intentKey({ ...intent, ...change })).not.toBe(intentKey(intent));
    }
  });
});

describe('SideEffectLedger', () => {
  let db: DatabaseSync;
  let close: () => void;
  let clock: ReturnType<typeof fakeClock>;
  let ledger: SideEffectLedger;

  beforeEach(async () => {
    ({ db, close } = await testDatabase());
    clock = fakeClock();
    ledger = new SideEffectLedger(db, clock.now);
  });
  afterEach(() => close());

  it('walks reserved → executing → completed and then reports already_done', () => {
    const r = ledger.reserve(intent, 'run-1', 'h1');
    expect(r.action).toBe('execute');
    ledger.markExecuting(r.effect.id);
    ledger.markCompleted(r.effect.id, { messageId: 'm1' });
    const again = ledger.reserve(intent, 'run-2', 'h1');
    expect(again).toMatchObject({ action: 'already_done', effect: { id: r.effect.id, status: 'completed' } });
    expect(JSON.parse(again.effect.external_refs)).toEqual({ messageId: 'm1' });
  });

  it('demands reconciliation for executing and unknown, and re-executes only from not_sent', () => {
    const r = ledger.reserve(intent, 'run-1', 'h1');
    ledger.markExecuting(r.effect.id);
    expect(ledger.reserve(intent, 'run-1', 'h1').action).toBe('reconcile');
    ledger.markUnknown(r.effect.id, 'timeout');
    expect(ledger.reserve(intent, 'run-1', 'h1').action).toBe('reconcile');
    ledger.markNotSent(r.effect.id, 'absent', 'provider_lookup');
    const retry = ledger.reserve(intent, 'run-1', 'h2');
    expect(retry).toMatchObject({
      action: 'execute',
      effect: { id: r.effect.id, status: 'reserved', content_hash: 'h2' },
    });
  });

  it('a reservation never marked executing is safe to execute again', () => {
    const r = ledger.reserve(intent, 'run-1', 'h1');
    expect(ledger.reserve(intent, 'run-1', 'h1')).toMatchObject({
      action: 'execute',
      effect: { id: r.effect.id },
    });
  });

  it('rejects illegal transitions', () => {
    const r = ledger.reserve(intent, 'run-1', 'h1');
    expect(() => ledger.markCompleted(r.effect.id)).toThrow(/cannot go from reserved/);
    expect(() => ledger.markUnknown(r.effect.id, 'x')).toThrow(/cannot go from reserved/);
    ledger.markExecuting(r.effect.id);
    ledger.markCompleted(r.effect.id);
    expect(() => ledger.markNotSent(r.effect.id, 'x')).toThrow(/cannot go from completed/);
    expect(() => ledger.markExecuting('missing')).toThrow(/not found/);
  });

  it('counts executing, completed and unknown as touches, but not reserved or not_sent', () => {
    const mk = (target: string) => ledger.reserve({ ...intent, target }, 'run', 'h').effect.id;
    const done = mk('a@x.test');
    ledger.markExecuting(done);
    ledger.markCompleted(done);
    const unsure = mk('b@x.test');
    ledger.markExecuting(unsure);
    ledger.markUnknown(unsure, 'timeout');
    mk('c@x.test'); // reserved only
    const rejected = mk('d@x.test');
    ledger.markNotSent(rejected, 'rejected');
    const targets = ['a', 'b', 'c', 'd'].map((t) => ({ channel: 'test', target: `${t}@x.test` }));
    const since = new Date(clock.now().getTime() - 1_000);
    expect(ledger.touchesSince(targets, since)).toHaveLength(2);
    expect(ledger.touchesSince([{ channel: 'email', target: 'a@x.test' }], since)).toEqual([]);
    clock.advance(10_000);
    expect(ledger.touchesSince(targets, new Date(clock.now().getTime() - 1_000))).toEqual([]);
    expect(ledger.touchesSince([], since)).toEqual([]);
  });
});

describe('executeSideEffect with the test channel', () => {
  let db: DatabaseSync;
  let close: () => void;
  let ledger: SideEffectLedger;
  let channel: TestChannel;
  const message = { target: intent.target, subject: 'Hi', body: 'Hello Ann', contentHash: 'h1' };
  const run = (signal = new AbortController().signal) =>
    executeSideEffect({ ledger, channel, intent, workflowRunId: 'run-1', message, signal });

  beforeEach(async () => {
    ({ db, close } = await testDatabase());
    const clock = fakeClock();
    ledger = new SideEffectLedger(db, clock.now);
    channel = new TestChannel(db, clock.now);
  });
  afterEach(() => close());

  it('sends once and treats a repeat as already done', async () => {
    expect(await run()).toMatchObject({ outcome: 'completed', alreadyDone: false });
    expect(await run()).toMatchObject({ outcome: 'completed', alreadyDone: true });
    expect(channel.deliveries()).toEqual([
      { idempotency_key: intentKey(intent), target: intent.target, subject: 'Hi', body: 'Hello Ann' },
    ]);
  });

  it('crash after delivery: the next run reconciles and does not send twice', async () => {
    channel.force('hang_after_delivery');
    void run(); // core "dies" here: the promise never settles
    await new Promise((r) => setImmediate(r));
    expect(ledger.byKey(intentKey(intent))?.status).toBe('executing');

    const after = await run();
    expect(after).toMatchObject({ outcome: 'completed', alreadyDone: true });
    expect(ledger.byKey(intentKey(intent))).toMatchObject({
      status: 'completed',
      reconciled_by: 'provider_lookup',
    });
    expect(channel.deliveries()).toHaveLength(1);
  });

  it('crash before delivery: reconciliation proves absence, then it sends exactly once', async () => {
    channel.force('hang_before_delivery');
    void run();
    await new Promise((r) => setImmediate(r));
    expect(await run()).toMatchObject({ outcome: 'completed', alreadyDone: false });
    expect(channel.deliveries()).toHaveLength(1);
  });

  it('an uncertain send stays unknown until reconciled, and is never re-sent blindly', async () => {
    channel.force('unknown');
    expect(await run()).toMatchObject({ outcome: 'unknown', errorClass: 'test_no_confirmation' });
    expect(ledger.byKey(intentKey(intent))?.status).toBe('unknown');
    // The test channel did deliver; reconciliation finds it.
    expect(await run()).toMatchObject({ outcome: 'completed', alreadyDone: true });
    expect(channel.deliveries()).toHaveLength(1);
  });

  it('a rejected send is not_sent and may be executed again', async () => {
    channel.force('not_sent');
    expect(await run()).toMatchObject({ outcome: 'not_sent', errorClass: 'test_rejected' });
    expect(channel.deliveries()).toHaveLength(0);
    expect(await run()).toMatchObject({ outcome: 'completed', alreadyDone: false });
    expect(channel.deliveries()).toHaveLength(1);
  });

  it('a throwing channel is recorded as unknown', async () => {
    const throwing = Object.assign(Object.create(channel) as TestChannel, {
      send: () => Promise.reject(new Error('socket closed')),
    });
    const out = await executeSideEffect({
      ledger,
      channel: throwing,
      intent,
      workflowRunId: 'r',
      message,
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({ outcome: 'unknown', errorClass: 'send_threw' });
  });
});
