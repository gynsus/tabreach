import { silentLogger, type RequestOf, type RequestType, type ResponseOf } from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctx, testServices } from '../prospects/test-helpers.js';

describe('app control (Phase 5c)', () => {
  let env: Awaited<ReturnType<typeof testServices>>;
  const calls: string[] = [];
  const awake: boolean[] = [];
  const worker = {
    request<T extends RequestType>(type: T, _payload: RequestOf<T>): Promise<ResponseOf<T>> {
      calls.push(type);
      return Promise.resolve({ ok: true } as ResponseOf<T>);
    },
  };
  beforeEach(async () => {
    calls.length = 0;
    awake.length = 0;
    env = await testServices({ worker: () => worker, keepAwake: (on) => awake.push(on) });
  });
  afterEach(() => env.close());
  const s = () => env.services;
  const actions = () =>
    (
      env.db
        .prepare(`SELECT action_type FROM action_events WHERE action_type LIKE 'app.%' ORDER BY rowid`)
        .all() as {
        action_type: string;
      }[]
    ).map((r) => r.action_type);

  it('pause and resume are recorded once and survive a restart', async () => {
    expect(s().appControl.get()).toMatchObject({ paused: false, keepAwake: false });
    s().appControl.pauseAll(ctx());
    s().appControl.pauseAll(ctx());
    expect(s().appControl.isPaused()).toBe(true);
    const { AppServices } = await import('../app-handlers.js');
    expect(new AppServices(env.db, {}).appControl.isPaused()).toBe(true);
    s().appControl.resumeAll(ctx());
    expect(actions()).toEqual(['app.paused', 'app.resumed']);
  });

  it('emergency stop pauses and stops the browser at once; a silent worker does not undo it', async () => {
    const control = await s().appControl.emergencyStop(ctx());
    expect(control).toMatchObject({ paused: true });
    expect(control.emergencyStoppedAt).not.toBeNull();
    expect(calls).toEqual(['worker.emergencyStop']);

    const broken = await testServices({
      worker: () => ({ request: () => Promise.reject(new Error('gone')) }),
      logger: silentLogger,
    });
    try {
      expect(await broken.services.appControl.emergencyStop(ctx())).toMatchObject({ paused: true });
    } finally {
      broken.close();
    }
  });

  it('keeps the Mac awake only when wanted, a campaign is active and nothing is paused', () => {
    s().appControl.setKeepAwake(true, ctx());
    expect(awake.at(-1)).toBe(false); // no active campaign
    env.db
      .prepare(
        `INSERT INTO campaigns (id, name, status, draft_config, created_at, updated_at) VALUES ('c1', 'C', 'active', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    s().appControl.syncKeepAwake();
    expect(awake.at(-1)).toBe(true);
    s().appControl.pauseAll(ctx());
    expect(awake.at(-1)).toBe(false);
  });
});
