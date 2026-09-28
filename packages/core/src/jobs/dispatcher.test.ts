import type { DatabaseSync } from 'node:sqlite';
import { silentLogger } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fakeClock, testDatabase } from '../db/test-db.js';
import { backoffMs, Dispatcher, PermanentError, RetryableError, type JobType } from './dispatcher.js';
import { JobQueue } from './queue.js';

describe('backoffMs', () => {
  it('grows exponentially with jitter and is capped', () => {
    expect(backoffMs(1, () => 0.5)).toBe(5_000);
    expect(backoffMs(2, () => 0.5)).toBe(10_000);
    expect(backoffMs(3, () => 0)).toBe(16_000);
    expect(backoffMs(3, () => 1)).toBe(24_000);
    expect(backoffMs(40, () => 0.5)).toBe(3_600_000);
  });
});

describe('Dispatcher', () => {
  let db: DatabaseSync;
  let close: () => void;
  let clock: ReturnType<typeof fakeClock>;
  let queue: JobQueue;
  let dispatcher: Dispatcher;
  let finished: string[];

  beforeEach(async () => {
    ({ db, close } = await testDatabase());
    clock = fakeClock();
    queue = new JobQueue(db, clock.now);
    finished = [];
    dispatcher = new Dispatcher({
      queue,
      now: clock.now,
      logger: silentLogger,
      owner: 'me',
      onFinished: (job, status) => finished.push(`${job.type}:${status}`),
    });
  });
  afterEach(() => {
    dispatcher.stop();
    close();
  });

  const type = <P>(t: Partial<JobType<P>> & Pick<JobType<P>, 'type' | 'handler'>): JobType<P> => ({
    payload: z.any() as unknown as z.ZodType<P>,
    sideEffecting: false,
    ...t,
  });

  it('runs due jobs with a validated payload, including jobs they enqueue for now', async () => {
    const seen: number[] = [];
    dispatcher.register(
      type<{ n: number }>({
        type: 'count',
        payload: z.object({ n: z.number() }),
        handler: ({ n }) => {
          seen.push(n);
          if (n < 3) queue.enqueue('count', { n: n + 1 });
        },
      }),
    );
    queue.enqueue('count', { n: 1 });
    await dispatcher.runDue();
    expect(seen).toEqual([1, 2, 3]);
    expect(finished).toEqual(['count:succeeded', 'count:succeeded', 'count:succeeded']);
  });

  it('fails jobs with an invalid payload or no handler without calling anything', async () => {
    dispatcher.register(type({ type: 'strict', payload: z.object({ n: z.number() }), handler: () => {} }));
    const bad = queue.enqueue('strict', { n: 'x' }) as string;
    const orphan = queue.enqueue('nobody', {}) as string;
    await dispatcher.runDue();
    expect(queue.get(bad)).toMatchObject({ status: 'failed', last_error_class: 'invalid_payload' });
    expect(queue.get(orphan)).toMatchObject({ status: 'failed', last_error_class: 'unknown_job_type' });
  });

  it('retries retryable errors with backoff and buries them when attempts run out', async () => {
    dispatcher.register(
      type({
        type: 'flaky',
        handler: () => {
          throw new RetryableError('network', 'Bearer abc123def456ghi failed');
        },
      }),
    );
    const id = queue.enqueue('flaky', {}, { maxAttempts: 2 }) as string;
    await dispatcher.runDue();
    const retry = queue.get(id);
    expect(retry).toMatchObject({ status: 'pending', attempts: 1, last_error_class: 'network' });
    expect(retry?.last_error_redacted).not.toContain('abc123');
    const wait = new Date(retry?.run_at as string).getTime() - clock.now().getTime();
    expect(wait).toBeGreaterThanOrEqual(4_000);
    expect(wait).toBeLessThanOrEqual(6_000);

    await dispatcher.runDue(); // not due yet
    expect(queue.get(id)?.attempts).toBe(1);
    clock.advance(wait);
    await dispatcher.runDue();
    expect(queue.get(id)).toMatchObject({ status: 'dead', attempts: 2 });
    expect(finished).toEqual(['flaky:retry', 'flaky:dead']);
  });

  it('honours an explicit retryAt and fails permanent errors immediately', async () => {
    const at = new Date(clock.now().getTime() + 3_600_000);
    dispatcher.register(
      type({
        type: 'wait',
        handler: () => {
          throw new RetryableError('spacing', 'too soon', at);
        },
      }),
    );
    dispatcher.register(
      type({
        type: 'blocked',
        handler: () => {
          throw new PermanentError('suppressed');
        },
      }),
    );
    const w = queue.enqueue('wait', {}) as string;
    const b = queue.enqueue('blocked', {}) as string;
    await dispatcher.runDue();
    expect(queue.get(w)?.run_at).toBe(at.toISOString());
    expect(queue.get(b)).toMatchObject({ status: 'failed', last_error_class: 'suppressed', attempts: 1 });
  });

  it('buries jobs older than maxAgeMs instead of retrying them', async () => {
    dispatcher.register(
      type({
        type: 'stale',
        maxAgeMs: 60_000,
        handler: () => {
          throw new Error('boom');
        },
      }),
    );
    const id = queue.enqueue('stale', {}, { runAt: new Date(clock.now().getTime() + 120_000) }) as string;
    clock.advance(120_000);
    await dispatcher.runDue();
    expect(queue.get(id)).toMatchObject({ status: 'dead', last_error_class: 'unexpected' });
  });

  it('never runs more than the type concurrency at once', async () => {
    let active = 0;
    let peak = 0;
    dispatcher.register(
      type({
        type: 'slow',
        concurrency: 2,
        handler: async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        },
      }),
    );
    for (let i = 0; i < 6; i++) queue.enqueue('slow', {});
    await dispatcher.runDue();
    expect(peak).toBe(2);
    expect(finished.filter((f) => f === 'slow:succeeded')).toHaveLength(6);
  });

  it('on start, takes back jobs a crashed previous core left running', async () => {
    const ran: string[] = [];
    dispatcher.register(
      type({ type: 't', handler: (_p, ctx) => void ran.push(`${ctx.jobId}:${ctx.attempt}`) }),
    );
    const id = queue.enqueue('t', {}) as string;
    queue.claim('previous-core', 60_000, new Map([['t', 1]]), 1);
    dispatcher.start();
    dispatcher.pause(); // stop the timer; drive it by hand
    await dispatcher.runDue();
    expect(ran).toEqual([`${id}:2`]);
  });
});
