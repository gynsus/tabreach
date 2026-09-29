import {
  silentLogger,
  uuidv7,
  type RequestOf,
  type RequestType,
  type ResponseOf,
  type TaskResult,
} from '@tabreach/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSideEffect } from '../ledger/execute.js';
import { ctx, testServices } from '../prospects/test-helpers.js';
import { BrowserActionChannel, packActionDispatch } from './browser-channel.js';

/** What the worker does with the next commit task. */
type Script =
  | 'succeed'
  | 'reject'
  | 'unrecognized'
  | 'crash_before_checkpoint'
  | 'crash_after_checkpoint'
  | 'unsupported'
  | 'control_taken';

const result = (over: Partial<TaskResult>): TaskResult => ({
  status: 'succeeded',
  stateId: 'site.thanks',
  stateKind: 'page',
  packVersion: '1.0.0',
  url: 'https://site.test/contact',
  diagnostics: null,
  errorKey: null,
  committed: true,
  ...over,
});

describe('browser action channel: the about_to_commit checkpoint in core (Phase 5c)', () => {
  let env: Awaited<ReturnType<typeof testServices>>;
  const scripts: Script[] = [];
  const commits: string[] = [];
  const worker = {
    async request<T extends RequestType>(type: T, payload: RequestOf<T>): Promise<ResponseOf<T>> {
      if (type === 'profile.open') return { chromeVersion: '140', currentUrl: null } as ResponseOf<T>;
      if (type !== 'task.run') return { ok: true } as ResponseOf<T>;
      const { taskId } = payload as RequestOf<'task.run'>;
      commits.push(taskId);
      const script = scripts.shift() ?? 'succeed';
      if (script === 'unsupported') {
        return result({ status: 'unsupported_state', stateId: null, committed: false }) as ResponseOf<T>;
      }
      if (script === 'crash_before_checkpoint') throw new Error('worker exited');
      if (script === 'control_taken') {
        return result({ status: 'failed', errorKey: 'task.controlTaken', committed: false }) as ResponseOf<T>;
      }
      // The worker asks core before pressing, exactly as over the port.
      const { proceed } = env.services.checkpoints.reach({ taskId, phase: 'about_to_commit' });
      if (!proceed) {
        return result({
          status: 'failed',
          errorKey: 'task.checkpointRefused',
          committed: false,
        }) as ResponseOf<T>;
      }
      if (script === 'crash_after_checkpoint') throw new Error('worker exited');
      if (script === 'reject')
        return result({
          status: 'failed',
          stateId: 'site.error',
          errorKey: 'task.rejected',
        }) as ResponseOf<T>;
      if (script === 'unrecognized') return result({ status: 'unknown', stateId: null }) as ResponseOf<T>;
      return result({}) as ResponseOf<T>;
    },
  };
  let channel: BrowserActionChannel;
  let runId: string;
  beforeEach(async () => {
    scripts.length = 0;
    commits.length = 0;
    env = await testServices({ worker: () => worker });
    const profile = env.services.browser.create({ name: 'Forms', purpose: 'general' }, ctx());
    channel = new BrowserActionChannel(
      'web_form',
      profile.id,
      packActionDispatch({
        packId: 'site',
        packVersion: '1.0.0',
        actionId: 'site.send',
        url: (m) => m.target,
        params: (m) => ({ body: m.body }),
        mode: 'auto',
      }),
      {
        db: env.db,
        now: () => new Date(),
        browser: env.services.browser,
        checkpoints: env.services.checkpoints,
        worker: () => worker,
        logger: silentLogger,
      },
    );
    runId = uuidv7();
    const ts = new Date().toISOString();
    env.db
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_type, definition_version, business_type, business_id, status,
                                    current_state, context, correlation_id, created_at, updated_at)
         VALUES (?, 'campaign_message', 1, 'enrollment', ?, 'running', 'SEND', '{}', ?, ?, ?)`,
      )
      .run(runId, uuidv7(), uuidv7(), ts, ts);
  });
  afterEach(() => env.close());

  const send = () =>
    executeSideEffect({
      ledger: env.services.ledger,
      channel,
      intent: {
        scopeId: runId,
        stepPosition: 1,
        channel: 'web_form',
        actionType: 'form.submit',
        target: 'https://site.test/contact',
      },
      workflowRunId: runId,
      message: { target: 'https://site.test/contact', subject: null, body: 'Hello', contentHash: 'h1' },
      signal: new AbortController().signal,
    });
  const status = (id: string) => env.services.ledger.get(id)?.status;

  it('records "executing" at the checkpoint and completes on a recognized success', async () => {
    const outcome = await send();
    expect(outcome).toMatchObject({ outcome: 'completed', alreadyDone: false });
    expect(status(outcome.sideEffectId)).toBe('completed');
    const task = env.db.prepare(`SELECT status, checkpoint FROM browser_tasks`).get() as {
      status: string;
      checkpoint: string;
    };
    expect(task.status).toBe('succeeded');
    expect(JSON.parse(task.checkpoint)).toMatchObject({ phase: 'about_to_commit' });
    expect(await send()).toMatchObject({ outcome: 'completed', alreadyDone: true });
    expect(commits).toHaveLength(1);
  });

  it('a worker crash after the checkpoint is unknown and is never pressed again (exit criterion)', async () => {
    scripts.push('crash_after_checkpoint');
    const first = await send();
    expect(first).toMatchObject({ outcome: 'unknown', errorClass: 'worker_lost_after_checkpoint' });
    expect(status(first.sideEffectId)).toBe('unknown');
    // The run comes back (retry, restart): reconciliation cannot tell, so it stays unknown.
    expect(await send()).toMatchObject({ outcome: 'unknown' });
    expect(commits).toHaveLength(1);
    // A person confirms it happened; the step then moves on without pressing.
    env.services.resolveSideEffect(first.sideEffectId, 'completed', uuidv7());
    expect(await send()).toMatchObject({ outcome: 'completed', alreadyDone: true });
    expect(commits).toHaveLength(1);
  });

  it('a crash before the checkpoint is a verified "not sent": running it again is safe', async () => {
    scripts.push('crash_before_checkpoint');
    const first = await send();
    expect(first).toMatchObject({
      outcome: 'not_sent',
      errorClass: 'failed_before_commit',
      permanent: false,
    });
    expect(await send()).toMatchObject({ outcome: 'completed' });
    expect(commits).toHaveLength(2);
  });

  it('an unrecognized result after the press is unknown; the window stays open, paused, for the person', async () => {
    scripts.push('unrecognized');
    const outcome = await send();
    expect(outcome).toMatchObject({ outcome: 'unknown', errorClass: 'browser_unverified' });
    const profile = env.services.browser.list(false)[0];
    expect(profile?.session).toMatchObject({ controlMode: 'paused' });
  });

  it('a refusal the site showed is not sent, permanently; an unknown page is not sent without a checkpoint', async () => {
    scripts.push('reject', 'unsupported');
    expect(await send()).toMatchObject({ outcome: 'not_sent', errorClass: 'site_rejected', permanent: true });
    const second = await send();
    expect(second).toMatchObject({ outcome: 'not_sent', errorClass: 'unsupported_state', permanent: true });
  });

  it('“Pause all” stops a task in flight at its checkpoint: nothing is pressed', async () => {
    env.services.appControl.pauseAll(ctx());
    const outcome = await send();
    expect(outcome).toMatchObject({ outcome: 'not_sent', errorClass: 'task.checkpointRefused' });
    expect(status(outcome.sideEffectId)).toBe('not_sent');
  });

  it('refuses a checkpoint nobody expects', () => {
    expect(env.services.checkpoints.reach({ taskId: uuidv7(), phase: 'about_to_commit' })).toEqual({
      proceed: false,
    });
  });

  it('a window the person took before the checkpoint stays open for them; nothing was sent (audit 5.5)', async () => {
    scripts.push('control_taken');
    expect(await send()).toMatchObject({ outcome: 'not_sent', errorClass: 'user_control' });
    expect(env.services.browser.list(false)[0]?.session).not.toBeNull();
  });
});
