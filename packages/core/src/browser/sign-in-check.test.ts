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
  beforeEach(async () => {
    worker = new FakeWorker();
    env = await testServices({ worker: () => worker });
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
    expect(worker.calls.map((c) => c.type)).toEqual(['profile.open', 'task.run', 'session.focus']);
    expect(worker.calls[0]?.payload).toMatchObject({ controlMode: 'automation' });

    await s().signInChecks.resolve(intervention!.id, 'done', ctx());
    await dispatcher.runDue();
    expect(runOf(p.id)).toEqual({ status: 'completed', current_state: 'COMPLETE' });
    expect(worker.calls.map((c) => c.type).slice(3)).toEqual([
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
});
