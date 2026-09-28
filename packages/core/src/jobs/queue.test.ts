import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClock, testDatabase } from '../db/test-db.js';
import { JobQueue } from './queue.js';

describe('JobQueue', () => {
  let db: DatabaseSync;
  let close: () => void;
  let clock: ReturnType<typeof fakeClock>;
  let queue: JobQueue;
  let wakes: number;
  const all = new Map([['t', 10]]);

  beforeEach(async () => {
    ({ db, close } = await testDatabase());
    clock = fakeClock();
    wakes = 0;
    queue = new JobQueue(db, clock.now, () => wakes++);
  });
  afterEach(() => close());

  it('claims only due jobs, in run_at order, and wakes the dispatcher on enqueue', () => {
    const later = queue.enqueue('t', { n: 2 }, { runAt: new Date(clock.now().getTime() + 60_000) });
    const first = queue.enqueue('t', { n: 1 });
    expect(wakes).toBe(2);
    expect(queue.claim('a', 60_000, all, 10).map((j) => j.id)).toEqual([first]);
    clock.advance(60_000);
    const [job] = queue.claim('a', 60_000, all, 10);
    expect(job?.id).toBe(later);
    expect(job?.attempts).toBe(1);
    expect(queue.get(later as string)?.status).toBe('running');
  });

  it('deduplicates active jobs by key and frees the key when the job finishes', () => {
    const id = queue.enqueue('t', {}, { dedupeKey: 'k' });
    expect(queue.enqueue('t', {}, { dedupeKey: 'k' })).toBeNull();
    queue.claim('a', 60_000, all, 10);
    queue.succeed(id as string);
    expect(queue.enqueue('t', {}, { dedupeKey: 'k' })).not.toBeNull();
  });

  it('respects per-type limits', () => {
    for (let i = 0; i < 3; i++) queue.enqueue('send', {});
    queue.enqueue('other', {});
    const claimed = queue.claim(
      'a',
      60_000,
      new Map([
        ['send', 1],
        ['other', 1],
      ]),
      10,
    );
    expect(claimed.map((j) => j.type).sort()).toEqual(['other', 'send']);
    expect(queue.claim('a', 60_000, new Map([['send', 0]]), 10)).toEqual([]);
  });

  it('recovers jobs whose lease expired, but not renewed ones', () => {
    const a = queue.enqueue('t', {}) as string;
    const b = queue.enqueue('t', {}) as string;
    queue.claim('owner', 60_000, all, 10);
    clock.advance(40_000);
    queue.renew(b, 'owner', 60_000);
    clock.advance(30_000);
    expect(queue.recoverExpired().map((j) => j.id)).toEqual([a]);
    expect(queue.get(a)?.status).toBe('pending');
    expect(queue.get(b)?.status).toBe('running');
  });

  it('releases jobs of a previous core instance regardless of lease', () => {
    const id = queue.enqueue('t', {}) as string;
    queue.claim('old', 60_000, all, 10);
    expect(queue.releaseOtherOwners('new')).toBe(1);
    expect(queue.get(id)?.status).toBe('pending');
    expect(queue.get(id)?.lease_owner).toBeNull();
  });

  it('retries later, buries, requeues with a fresh budget and dismisses', () => {
    const id = queue.enqueue('t', {}) as string;
    queue.claim('a', 60_000, all, 10);
    const at = new Date(clock.now().getTime() + 5_000);
    queue.retryLater(id, at, 'network', 'socket hang up');
    expect(queue.get(id)).toMatchObject({ status: 'pending', last_error_class: 'network', attempts: 1 });
    expect(queue.nextRunAt()?.toISOString()).toBe(at.toISOString());

    clock.advance(5_000);
    queue.claim('a', 60_000, all, 10);
    queue.bury(id, 'network', 'still down');
    expect(queue.needsAttention().map((j) => j.id)).toEqual([id]);
    expect(queue.nextRunAt()).toBeNull();

    expect(queue.requeue(id)).toBe(true);
    expect(queue.get(id)).toMatchObject({ status: 'pending', attempts: 0, last_error_class: null });
    expect(queue.dismiss(id)).toBe(false); // only finished-with-problem jobs can be dismissed
    queue.claim('a', 60_000, all, 10);
    queue.fail(id, 'invalid', 'bad input');
    expect(queue.dismiss(id)).toBe(true);
    expect(queue.get(id)).toBeUndefined();
  });

  it('joins the caller transaction: a rolled-back enqueue leaves no job', () => {
    db.exec('BEGIN');
    queue.enqueue('t', {});
    db.exec('ROLLBACK');
    expect(queue.nextRunAt()).toBeNull();
  });
});
