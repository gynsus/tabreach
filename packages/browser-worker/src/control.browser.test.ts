import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPack, parseAdapterPack } from '@tabreach/adapter-packs';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger, uuidv7, type SessionModeChanged } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { BrowserWorker } from './worker.js';

// A pack whose only state never matches the fixture home page: a task there keeps polling.
const neverPack = parseAdapterPack({
  id: 'fixture',
  version: '1.0.0',
  channel: 'web_form',
  states: [{ id: 'fixture.never', url: ['http://127.0.0.1*/never'], requires: [{ textAny: ['never'] }] }],
});

let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(() => fixtures.close());

describe('control: overlay, taking over, emergency stop (Phase 5c)', () => {
  let root: string;
  let profiles: ProfileManager;
  let worker: BrowserWorker;
  let core: RpcPeer;
  const modes: SessionModeChanged[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-control-'));
    profiles = new ProfileManager({ root, headless: true, keychain: false, logger: silentLogger });
    const [coreSide, workerSide] = createEndpointPair();
    worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      profiles,
      tasks: {
        diagnosticsDir: join(root, 'diag'),
        pack: (id) => (id === 'fixture' ? neverPack : bundledPack(id)),
      },
    });
    core = new RpcPeer(coreSide);
    modes.length = 0;
    core.on('session.modeChanged', (m) => modes.push(m));
  });
  afterEach(async () => {
    worker.close();
    await profiles.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const open = async (controlMode: 'automation' | 'human') => {
    const sessionId = uuidv7();
    await core.request(
      'profile.open',
      { profileId: uuidv7(), sessionId, channel: 'chrome', startUrl: fixtures.url, controlMode },
      { timeoutMs: 60_000 },
    );
    return { sessionId, page: profiles.contextOf(sessionId)!.pages()[0]! };
  };
  const modeShown = (page: Page) => page.locator('tabreach-overlay').getAttribute('data-tabreach-mode');

  it('the page can only pause: through the overlay binding, nothing else is accepted', async () => {
    const { sessionId, page } = await open('automation');
    await expect.poll(() => modeShown(page)).toBe('automation');
    await page.evaluate("window.__tabreachOverlay('resume')");
    await expect.poll(() => modeShown(page)).toBe('automation');
    await page.evaluate("window.__tabreachOverlay('pause_requested')");
    await expect.poll(() => modes).toEqual([{ sessionId, controlMode: 'paused', by: 'overlay' }]);
    await expect.poll(() => modeShown(page)).toBe('paused');
    // A page cannot resume: only the app can, and automation stays blocked meanwhile.
    await page.evaluate("window.__tabreachOverlay('resume')");
    await expect(
      core.request('task.run', {
        taskId: uuidv7(),
        sessionId,
        taskType: 'check_state',
        packId: 'fixture',
        url: fixtures.url,
      }),
    ).rejects.toMatchObject({ problem: { detail: 'session.notAutomation' } });
  });

  it('taking control stops a running task at once; a window the person opened has no overlay', async () => {
    const { sessionId } = await open('automation');
    const started = Date.now();
    const running = core.request(
      'task.run',
      { taskId: uuidv7(), sessionId, taskType: 'check_state', packId: 'fixture', url: fixtures.url },
      { timeoutMs: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 1_500));
    await core.request('session.setMode', { sessionId, controlMode: 'human' });
    expect(await running).toMatchObject({ status: 'failed', errorKey: 'task.controlTaken' });
    expect(Date.now() - started).toBeLessThan(10_000); // not the 15 s of recognizing
    const mine = await open('human');
    expect(await mine.page.locator('tabreach-overlay').count()).toBe(0);
  }, 60_000);

  it('emergency stop pauses every automated session and tells core', async () => {
    const a = await open('automation');
    const b = await open('automation');
    await core.request('worker.emergencyStop', {});
    expect(modes.map((m) => [m.sessionId, m.controlMode, m.by]).sort()).toEqual(
      [
        [a.sessionId, 'paused', 'emergency_stop'],
        [b.sessionId, 'paused', 'emergency_stop'],
      ].sort(),
    );
  }, 60_000);

  it('one task per session; core can cancel it (audit 5.5)', async () => {
    const { sessionId } = await open('automation');
    const taskId = uuidv7();
    const task = { sessionId, taskType: 'check_state' as const, packId: 'fixture', url: fixtures.url };
    const running = core.request('task.run', { ...task, taskId }, { timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 1_000));
    await expect(core.request('task.run', { ...task, taskId: uuidv7() })).rejects.toMatchObject({
      problem: { detail: 'session.busy' },
    });
    const started = Date.now();
    await core.request('task.cancel', { taskId });
    expect(await running).toMatchObject({ status: 'failed', errorKey: 'task.cancelled' });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The session is free again and still under automation.
    await expect(core.request('task.cancel', { taskId })).resolves.toEqual({ ok: true });
  }, 60_000);
});
