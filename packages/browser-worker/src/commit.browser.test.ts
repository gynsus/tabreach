import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPack, parseAdapterPack } from '@tabreach/adapter-packs';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger, uuidv7, type TaskResult } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { BrowserWorker } from './worker.js';

// Real installed Chrome, headless, against the fixture contact form (Phase 5c exit criteria).
const formPack = parseAdapterPack({
  id: 'fixture',
  version: '1.2.0',
  channel: 'web_form',
  states: [
    {
      id: 'fixture.contact.form',
      url: ['http://127.0.0.1*/contact/*'],
      requires: [
        { role: 'heading', nameAny: ['Contact us'] },
        { role: 'button', nameAny: ['Send'] },
      ],
    },
    {
      id: 'fixture.contact.thanks',
      url: ['http://127.0.0.1*/contact/*'],
      requires: [{ role: 'heading', nameAny: ['Thank you'] }],
    },
    {
      id: 'fixture.contact.rejected',
      url: ['http://127.0.0.1*/contact/*'],
      requires: [{ textAny: ['Please enter a longer message.'] }],
    },
  ],
  actions: [
    {
      id: 'fixture.contact.send',
      from: ['fixture.contact.form'],
      fill: [
        { control: { role: 'textbox', nameAny: ['Your name'] }, param: 'name' },
        { control: { role: 'textbox', nameAny: ['Message'] }, param: 'body' },
      ],
      commit: { role: 'button', nameAny: ['Send'] },
      success: ['fixture.contact.thanks'],
      rejected: ['fixture.contact.rejected'],
    },
  ],
});

let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(() => fixtures.close());

describe('critical actions: the about_to_commit checkpoint (Phase 5c)', () => {
  let root: string;
  let profiles: ProfileManager;
  let worker: BrowserWorker;
  let core: RpcPeer;
  let answer: () => Promise<{ proceed: boolean }>;
  /** How many times the site had received the form when core was asked. */
  let atCheckpoint: number[];
  let page: Page;
  let sessionId: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-commit-'));
    profiles = new ProfileManager({ root, headless: true, keychain: false, logger: silentLogger });
    const [coreSide, workerSide] = createEndpointPair();
    worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      profiles,
      tasks: {
        diagnosticsDir: join(root, 'diag'),
        pack: (id) => (id === 'fixture' ? formPack : bundledPack(id)),
      },
    });
    atCheckpoint = [];
    answer = () => Promise.resolve({ proceed: true });
    core = new RpcPeer(coreSide).handle('task.checkpoint', async () => {
      atCheckpoint.push(await submissions());
      return answer();
    });
    sessionId = uuidv7();
    await core.request(
      'profile.open',
      { profileId: uuidv7(), sessionId, channel: 'chrome', startUrl: null, controlMode: 'automation' },
      { timeoutMs: 60_000 },
    );
    page = profiles.contextOf(sessionId)!.pages()[0]!;
  });
  afterEach(async () => {
    worker.close();
    await profiles.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const submissions = async (): Promise<number> =>
    page.url().startsWith(fixtures.url)
      ? Number(await page.evaluate("JSON.parse(localStorage.getItem('fixture_submissions') ?? '[]').length"))
      : 0;
  const commit = (result: string, mode: 'auto' | 'assisted' = 'auto'): Promise<TaskResult> =>
    core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'fixture',
        url: `${fixtures.url}contact/?result=${result}`,
        actionId: 'fixture.contact.send',
        params: { name: 'Ann Lee', body: 'Hello from TabReach' },
        mode,
      },
      { timeoutMs: 60_000 },
    );

  it('fills, stops at the checkpoint before pressing, presses once and recognizes success', async () => {
    expect(await commit('thanks')).toMatchObject({
      status: 'succeeded',
      stateId: 'fixture.contact.thanks',
      committed: true,
      packVersion: '1.2.0',
    });
    expect(atCheckpoint).toEqual([0]); // nothing sent when core was asked
    expect(await page.evaluate("localStorage.getItem('fixture_submissions')")).toBe(
      JSON.stringify([{ name: 'Ann Lee', message: 'Hello from TabReach' }]),
    );
  }, 60_000);

  it('a refused or unanswered checkpoint never presses', async () => {
    answer = () => Promise.resolve({ proceed: false });
    expect(await commit('thanks')).toMatchObject({
      status: 'failed',
      errorKey: 'task.checkpointRefused',
      committed: false,
    });
    answer = () => Promise.reject(new Error('core is gone'));
    expect(await commit('thanks')).toMatchObject({ committed: false });
    expect(await submissions()).toBe(0);
  }, 60_000);

  it('a refusal shown by the site is a verified "not sent"; no recognizable result is unknown', async () => {
    expect(await commit('reject')).toMatchObject({
      status: 'failed',
      errorKey: 'task.rejected',
      committed: true,
    });
    expect(await commit('silent')).toMatchObject({ status: 'unknown', committed: true });
    expect(await submissions()).toBe(2); // one press each, never repeated
  }, 60_000);

  it('assisted: the person presses; taking control while waiting leaves it unknown, never repeated', async () => {
    const waiting = commit('thanks', 'assisted');
    await expect.poll(() => atCheckpoint.length, { timeout: 30_000 }).toBe(1);
    await page.getByRole('button', { name: 'Send' }).click(); // the person
    expect(await waiting).toMatchObject({ status: 'succeeded', committed: true });

    const again = commit('silent', 'assisted');
    await expect.poll(() => atCheckpoint.length, { timeout: 30_000 }).toBe(2);
    await core.request('session.setMode', { sessionId, controlMode: 'human' });
    expect(await again).toMatchObject({ status: 'unknown', committed: true, errorKey: 'task.controlTaken' });
    expect(await submissions()).toBe(1);
  }, 60_000);

  it('a page not in the allowlist is unsupported: no checkpoint, nothing pressed', async () => {
    const result = await core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'fixture',
        url: `${fixtures.url}login/`,
        actionId: 'fixture.contact.send',
        params: { name: 'x', body: 'y' },
        mode: 'auto',
      },
      { timeoutMs: 60_000 },
    );
    expect(result).toMatchObject({ status: 'unsupported_state', committed: false });
    expect(result.diagnostics?.expectedStates).toEqual(['fixture.contact.form']);
    expect(atCheckpoint).toEqual([]);
  }, 60_000);
});
