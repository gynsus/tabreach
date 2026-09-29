import {
  silentLogger,
  type RequestOf,
  type RequestType,
  type ResponseOf,
  type TaskResult,
} from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../jobs/dispatcher.js';
import { ctx, testServices } from '../prospects/test-helpers.js';

const result = (over: Partial<TaskResult>): TaskResult => ({
  status: 'succeeded',
  stateId: 'linkedin.feed',
  stateKind: 'logged_in',
  packVersion: '0.1.0',
  url: 'https://www.linkedin.com/feed/',
  diagnostics: null,
  errorKey: null,
  ...over,
});

/** The worker as core sees it: answers tasks from a queue, records what it was asked. */
class FakeWorker {
  readonly calls: { type: string; payload: unknown }[] = [];
  readonly results: TaskResult[] = [];
  request<T extends RequestType>(type: T, payload: RequestOf<T>): Promise<ResponseOf<T>> {
    this.calls.push({ type, payload });
    if (type === 'profile.open')
      return Promise.resolve({ chromeVersion: '140.0', currentUrl: 'about:blank' } as ResponseOf<T>);
    if (type === 'task.run') return Promise.resolve((this.results.shift() ?? result({})) as ResponseOf<T>);
    return Promise.resolve({ ok: true } as ResponseOf<T>);
  }
}

describe('sign-in check workflow (Phase 5b)', () => {
  let env: Awaited<ReturnType<typeof testServices>>;
  let worker: FakeWorker;
  let dispatcher: Dispatcher;
  const notices: string[] = [];
  beforeEach(async () => {
    worker = new FakeWorker();
    notices.length = 0;
    env = await testServices({
      worker: () => worker,
      notify: (title, body) => notices.push(`${title}: ${body}`),
    });
    dispatcher = new Dispatcher({ queue: env.services.jobs, now: () => new Date(), logger: silentLogger });
    for (const t of env.services.signInChecks.jobTypes()) dispatcher.register(t);
    dispatcher.start();
    dispatcher.pause();
  });
  afterEach(() => {
    dispatcher.stop();
    env.close();
  });
  const s = () => env.services;
  const profile = () => s().browser.create({ name: 'LinkedIn', purpose: 'general' }, ctx());
  const runOf = (profileId: string) =>
    env.db
      .prepare(
        `SELECT status, current_state FROM workflow_runs WHERE business_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(profileId);
  const modeOf = (profileId: string) => s().browser.get(profileId).session?.controlMode ?? null;

  it('a CAPTCHA puts the run in WAITING_FOR_HUMAN with the window paused; "done" checks again (exit criterion)', async () => {
    const p = profile();
    worker.results.push(
      result({ status: 'needs_human', stateId: 'generic.captcha.recaptcha', stateKind: 'challenge' }),
      result({}),
    );
    s().signInChecks.start(p.id, 'linkedin', ctx());
    await dispatcher.runDue();

    expect(runOf(p.id)).toEqual({ status: 'waiting_for_human', current_state: 'WAITING_FOR_HUMAN' });
    expect(modeOf(p.id)).toBe('paused');
    const [intervention] = s().signInChecks.interventions();
    expect(intervention).toMatchObject({
      reason: 'security_challenge',
      profileName: 'LinkedIn',
      sessionOpen: true,
      stateId: 'generic.captcha.recaptcha',
    });
    expect(worker.calls.map((c) => c.type)).toEqual([
      'profile.open',
      'session.setOverlay',
      'task.run',
      'session.focus',
    ]);
    expect(worker.calls[0]?.payload).toMatchObject({ controlMode: 'automation' });

    await s().signInChecks.resolve(intervention!.id, 'done', ctx());
    await dispatcher.runDue();
    expect(runOf(p.id)).toEqual({ status: 'completed', current_state: 'COMPLETE' });
    expect(worker.calls.map((c) => c.type).slice(4)).toEqual([
      'session.setMode',
      'task.run',
      'profile.close',
    ]);
    expect(s().browser.get(p.id)).toMatchObject({
      status: 'ready',
      session: null,
      health: { status: 'healthy', detail: 'linkedin.feed' },
    });
    expect(s().signInChecks.interventions()).toEqual([]);
  });

  it('the sign-in page marks the profile as needing sign-in', async () => {
    const p = profile();
    worker.results.push(
      result({ stateId: 'linkedin.login', stateKind: 'login', url: 'https://www.linkedin.com/login' }),
    );
    s().signInChecks.start(p.id, 'linkedin', ctx());
    await dispatcher.runDue();
    expect(s().browser.get(p.id)).toMatchObject({
      status: 'needs_login',
      health: { status: 'needs_login', detail: 'linkedin.login' },
    });
  });

  it('an unknown page asks the person, with diagnostics; cancel closes the window and ends the run', async () => {
    const p = profile();
    worker.results.push(
      result({
        status: 'unsupported_state',
        stateId: null,
        stateKind: null,
        diagnostics: {
          title: 'Odd',
          url: 'https://x.test/',
          screenshot: 't.png',
          ariaSnapshot: '- heading "Odd"',
          expectedStates: ['linkedin.feed'],
        },
      }),
    );
    s().signInChecks.start(p.id, 'linkedin', ctx());
    await dispatcher.runDue();
    const [i] = s().signInChecks.interventions();
    expect(i).toMatchObject({
      reason: 'unsupported_state',
      diagnostics: { title: 'Odd', expectedStates: ['linkedin.feed'] },
    });
    expect(worker.calls.find((c) => c.type === 'session.setMode')?.payload).toMatchObject({
      controlMode: 'paused',
    });
    await s().signInChecks.resolve(i!.id, 'cancel', ctx());
    expect(runOf(p.id)).toMatchObject({ status: 'cancelled' });
    expect(s().browser.get(p.id).session).toBeNull();
  });

  it('never takes over a window the person holds; a window closed while waiting ends the run', async () => {
    const held = profile();
    await s().browser.open(held.id, null, ctx());
    expect(() => s().signInChecks.start(held.id, 'linkedin', ctx())).toThrow(
      expect.objectContaining({ problem: expect.objectContaining({ detail: 'profile.inUseByYou' }) }),
    );

    const p = profile();
    worker.results.push(
      result({ status: 'needs_human', stateId: 'linkedin.checkpoint', stateKind: 'challenge' }),
    );
    s().signInChecks.start(p.id, 'linkedin', ctx());
    await dispatcher.runDue();
    const sessionId = s().browser.get(p.id).session!.id;
    s().browser.onSessionChanged({ sessionId, profileId: p.id, status: 'closed', currentUrl: null });
    expect(s().signInChecks.interventions()).toEqual([]);
    expect(runOf(p.id)).toMatchObject({ status: 'cancelled' });
  });

  describe('control (Phase 5c)', () => {
    /** A check whose first task is still running when the person steps in. */
    const started = async () => {
      const p = profile();
      s().signInChecks.start(p.id, 'linkedin', ctx());
      await dispatcher.runDue();
      return p;
    };

    it('taking control makes the work wait for the person; returning control checks again', async () => {
      worker.results.push(
        result({ status: 'failed', stateId: null, stateKind: null, errorKey: 'task.controlTaken' }),
      );
      const q = await started();
      expect(s().signInChecks.interventions()).toMatchObject([{ reason: 'user_control', profileId: q.id }]);
      expect(notices).toHaveLength(1);
      expect(runOf(q.id)).toMatchObject({ status: 'waiting_for_human' });

      await expect(s().signInChecks.takeControl(q.id, ctx())).resolves.toMatchObject({
        session: { controlMode: 'human' },
      });
      await s().signInChecks.returnControl(q.id, ctx());
      await dispatcher.runDue();
      expect(runOf(q.id)).toEqual({ status: 'completed', current_state: 'COMPLETE' });
      expect(s().signInChecks.interventions()).toEqual([]);
    });

    it('take control over an automated window records it and waits; a window the person opened has nothing to return to', async () => {
      worker.results.push(
        result({ status: 'needs_human', stateId: 'linkedin.checkpoint', stateKind: 'challenge' }),
      );
      const p = await started();
      const [challenge] = s().signInChecks.interventions();
      await s().signInChecks.takeControl(p.id, ctx());
      expect(modeOf(p.id)).toBe('human');
      expect(worker.calls.at(-1)).toMatchObject({
        type: 'session.setMode',
        payload: { controlMode: 'human' },
      });
      // Already waiting on the challenge: no second request.
      expect(
        s()
          .signInChecks.interventions()
          .map((i) => i.id),
      ).toEqual([challenge!.id]);

      const mine = profile();
      await s().browser.open(mine.id, null, ctx());
      await expect(s().signInChecks.returnControl(mine.id, ctx())).rejects.toMatchObject({
        problem: { detail: 'session.nothingToReturn' },
      });
      await expect(s().signInChecks.takeControl(profile().id, ctx())).rejects.toMatchObject({
        problem: { detail: 'profile.notOpen' },
      });
    });

    it('a Pause from the page or an emergency stop is recorded and asks the person', async () => {
      // A task the worker stopped because the page paused it; the event arrives after.
      worker.results.push(
        result({ status: 'failed', stateId: null, stateKind: null, errorKey: 'task.controlTaken' }),
      );
      const q = await started();
      const sessionId = s().browser.get(q.id).session!.id;
      s().signInChecks.onModeChanged({ sessionId, controlMode: 'paused', by: 'overlay' });
      s().signInChecks.onModeChanged({ sessionId, controlMode: 'paused', by: 'emergency_stop' });
      expect(modeOf(q.id)).toBe('paused');
      // One request per wait, however many times it was paused.
      expect(s().signInChecks.interventions()).toMatchObject([{ reason: 'user_control' }]);
      const paused = env.db
        .prepare(`SELECT payload_redacted AS payload FROM action_events WHERE action_type = 'session.paused'`)
        .all() as { payload: string }[];
      expect(paused.map((r) => JSON.parse(r.payload))).toEqual([{ by: 'overlay' }, { by: 'emergency_stop' }]);
    });

    it('a check started while everything is paused waits without opening a window', async () => {
      s().appControl.pauseAll(ctx());
      const p = profile();
      s().signInChecks.start(p.id, 'linkedin', ctx());
      await dispatcher.runDue();
      expect(worker.calls).toEqual([]);
      expect(runOf(p.id)).toMatchObject({ status: 'pending' });
    });
  });
});
