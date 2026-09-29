import { RpcError, uuidv7, type RequestOf, type RequestType, type ResponseOf } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, testServices } from '../prospects/test-helpers.js';

/** A worker that remembers what core asked and answers like the real one. */
class FakeWorker {
  readonly calls: { type: string; payload: unknown }[] = [];
  failOpen = false;
  request<T extends RequestType>(type: T, payload: RequestOf<T>): Promise<ResponseOf<T>> {
    this.calls.push({ type, payload });
    if (type === 'profile.open') {
      if (this.failOpen) return Promise.reject(new RpcError('CONFLICT', 'Profile in use', 'profile.inUse'));
      return Promise.resolve({ chromeVersion: '140.0.0.0', currentUrl: 'about:blank' } as ResponseOf<T>);
    }
    if (type === 'profile.healthCheck')
      return Promise.resolve({ status: 'busy', detail: 'profile.inUse' } as ResponseOf<T>);
    return Promise.resolve({ ok: true } as ResponseOf<T>);
  }
}

describe('browser profiles in core (Phase 5a)', () => {
  let env: Awaited<ReturnType<typeof testServices>>;
  let worker: FakeWorker | null;
  beforeEach(async () => {
    worker = new FakeWorker();
    env = await testServices({ worker: () => worker });
  });
  afterEach(() => env.close());
  const browser = () => env.services.browser;
  const sessionOf = (id: string) => browser().get(id).session;

  it('opens a profile under the user’s control, and closes it', async () => {
    const p = browser().create({ name: 'Research', purpose: 'research' }, ctx());
    expect(p).toMatchObject({
      status: 'ready',
      purpose: 'research',
      session: null,
      browserChannel: 'chrome',
    });
    const opened = await browser().open(p.id, 'https://example.com/', ctx());
    expect(opened).toMatchObject({ status: 'open', session: { status: 'open', controlMode: 'human' } });
    expect(worker?.calls[0]).toMatchObject({
      type: 'profile.open',
      payload: { profileId: p.id, channel: 'chrome', startUrl: 'https://example.com/' },
    });
    await expect(browser().open(p.id, null, ctx())).rejects.toMatchObject({
      problem: { detail: 'profile.alreadyOpen' },
    });
    expect(() => browser().archive(p.id, ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'profile.open' }) }),
    );
    expect(await browser().close(p.id, ctx())).toMatchObject({ status: 'ready', session: null });
  });

  it('a failed launch leaves no session; without a worker nothing opens', async () => {
    const p = browser().create({ name: 'General', purpose: 'general' }, ctx());
    worker!.failOpen = true;
    await expect(browser().open(p.id, null, ctx())).rejects.toMatchObject({
      problem: { detail: 'profile.inUse' },
    });
    expect(browser().get(p.id)).toMatchObject({ status: 'ready', session: null });
    worker = null;
    await expect(browser().open(p.id, null, ctx())).rejects.toMatchObject({
      problem: { detail: 'worker.notRunning' },
    });
  });

  it('the worker’s reports end sessions: closed window, heartbeat without it, worker gone', async () => {
    const a = browser().create({ name: 'A', purpose: 'general' }, ctx());
    const b = browser().create({ name: 'B', purpose: 'general' }, ctx());
    const c = browser().create({ name: 'C', purpose: 'general' }, ctx());
    for (const p of [a, b, c]) await browser().open(p.id, null, ctx());

    browser().onSessionChanged({
      sessionId: sessionOf(a.id)!.id,
      profileId: a.id,
      status: 'closed',
      currentUrl: null,
    });
    expect(browser().get(a.id)).toMatchObject({ status: 'ready', session: null });

    browser().onHeartbeat([{ sessionId: sessionOf(c.id)!.id, currentUrl: 'https://c.test/' }]);
    expect(browser().get(b.id)).toMatchObject({ status: 'ready', session: null });
    expect(sessionOf(c.id)).toMatchObject({ status: 'open', currentUrl: 'https://c.test/' });

    browser().onWorkerDetached();
    expect(browser().get(c.id)).toMatchObject({ status: 'ready', session: null });
    const interrupted = env.db
      .prepare(`SELECT COUNT(*) AS n FROM browser_sessions WHERE status = 'interrupted'`)
      .get() as { n: number };
    expect(interrupted.n).toBe(2);
  });

  it('closes windows nobody drives: unknown to core, or under automation after a reconnect (audit 5.5)', async () => {
    const mine = browser().create({ name: 'Mine', purpose: 'general' }, ctx());
    const auto = browser().create({ name: 'Auto', purpose: 'general' }, ctx());
    await browser().open(mine.id, null, ctx());
    const autoSession = await browser().openSession(auto.id, 'automation', null, uuidv7());
    const mineSession = sessionOf(mine.id)!.id;
    const stray = uuidv7();
    const closes = () =>
      worker!.calls
        .filter((c) => c.type === 'profile.close')
        .map((c) => (c.payload as { sessionId: string }).sessionId);
    const beat = [
      { sessionId: mineSession, currentUrl: null },
      { sessionId: autoSession, currentUrl: null },
      { sessionId: stray, currentUrl: null },
    ];
    browser().onHeartbeat(beat);
    expect(closes()).toEqual([stray]); // unknown to core

    browser().onWorkerAttached(); // a new core: the automation window's task is gone
    browser().onHeartbeat(beat);
    expect(closes().slice(1).sort()).toEqual([autoSession, stray].sort());
    // The person's own window is never closed.
    expect(closes()).not.toContain(mineSession);
  });

  it('deleting asks for the exact name and removes the directory through the worker', async () => {
    const p = browser().create({ name: 'LinkedIn – Anna', purpose: 'general' }, ctx());
    await expect(browser().delete(p.id, 'LinkedIn', ctx())).rejects.toMatchObject({
      problem: { fields: { confirmName: 'profile.nameMismatch' } },
    });
    await browser().delete(p.id, 'LinkedIn – Anna', ctx());
    expect(worker?.calls.at(-1)).toEqual({ type: 'profile.delete', payload: { profileId: p.id } });
    expect(browser().list(true)).toEqual([]);
  });

  it('health from the worker is kept; archived profiles are hidden unless asked for', async () => {
    const p = browser().create({ name: 'A', purpose: 'general' }, ctx());
    expect((await browser().check(p.id)).health).toMatchObject({ status: 'busy', detail: 'profile.inUse' });
    browser().archive(p.id, ctx());
    expect(browser().list(false)).toEqual([]);
    expect(browser().list(true)).toMatchObject([{ status: 'archived' }]);
  });
});
