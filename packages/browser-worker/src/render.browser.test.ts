import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger, uuidv7, type RenderResult } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { BrowserWorker } from './worker.js';

// Real installed Chrome against the fixture JavaScript-only site (Phase 5d).
let fixtures: FixtureServer;
let other: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
  other = await startFixtureServer();
});
afterAll(async () => {
  await fixtures.close();
  await other.close();
});

describe('research rendering in the research profile (Phase 5d)', () => {
  let root: string;
  let profiles: ProfileManager;
  let workers: BrowserWorker[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-render-'));
    profiles = new ProfileManager({ root, headless: true, keychain: false, logger: silentLogger });
    workers = [];
  });
  afterEach(async () => {
    for (const w of workers) w.close();
    await profiles.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  /** A worker whose address rules count the fixture server (loopback) as public, or the real rules. */
  const connect = (allowLoopback: boolean) => {
    const [coreSide, workerSide] = createEndpointPair();
    workers.push(
      new BrowserWorker({
        core: workerSide,
        logger: silentLogger,
        profiles,
        ...(allowLoopback ? { render: { isPublicAddress: () => true } } : {}),
      }),
    );
    return new RpcPeer(coreSide);
  };
  const openResearch = async (core: RpcPeer) => {
    const sessionId = uuidv7();
    await core.request(
      'profile.open',
      {
        profileId: uuidv7(),
        sessionId,
        channel: 'chrome',
        startUrl: null,
        controlMode: 'automation',
        headless: true,
      },
      { timeoutMs: 60_000 },
    );
    return sessionId;
  };
  const render = (core: RpcPeer, sessionId: string, url: string): Promise<RenderResult> =>
    core.request(
      'task.render',
      { taskId: uuidv7(), sessionId, url, site: '127.0.0.1' },
      { timeoutMs: 60_000 },
    );

  it('returns the text the scripts wrote; the headless research window has no overlay', async () => {
    const core = connect(true);
    const sessionId = await openResearch(core);
    const result = await render(core, sessionId, `${fixtures.url}spa/`);
    expect(result).toMatchObject({ status: 'ok', title: 'Northwind Robotics' });
    expect(result.html).toContain('autonomous forklifts for cold-storage warehouses');
    expect(result.html).not.toContain('tabreach-overlay');
  }, 60_000);

  it('never leaves the site and never reaches a non-public address', async () => {
    const core = connect(true);
    const sessionId = await openResearch(core);
    const offsite = await render(
      core,
      sessionId,
      `${fixtures.url}spa/?leave=${encodeURIComponent('http://localhost:1/')}`,
    );
    expect(offsite).toMatchObject({ status: 'blocked', reason: 'offsite', html: null });

    // With the real rules the fixture server itself is the user's own machine: refused outright.
    const strict = connect(false);
    const strictSession = await openResearch(strict);
    expect(await render(strict, strictSession, `${fixtures.url}spa/`)).toMatchObject({
      status: 'blocked',
      reason: 'blocked_address',
    });
  }, 60_000);

  it('a script on the page cannot call into the local network', async () => {
    // The page's host (127.0.0.1) counts as public here; "localhost" resolves to a private address.
    const probe = async (localhostAddress: string) => {
      const [coreSide, workerSide] = createEndpointPair();
      workers.push(
        new BrowserWorker({
          core: workerSide,
          logger: silentLogger,
          profiles,
          render: {
            resolveHost: () => Promise.resolve([localhostAddress]),
            isPublicAddress: (ip) => ip === '127.0.0.1',
          },
        }),
      );
      const core = new RpcPeer(coreSide);
      const sessionId = await openResearch(core);
      const target = other.url.replace('127.0.0.1', 'localhost');
      const result = await render(core, sessionId, `${fixtures.url}spa/?probe=${encodeURIComponent(target)}`);
      await profiles.closeAll();
      return result;
    };
    expect(await probe('10.0.0.5')).toMatchObject({ status: 'ok', title: 'Northwind Robotics' });
    // The same page reaches it when the address is allowed: the check above is what stopped it.
    expect(await probe('127.0.0.1')).toMatchObject({ status: 'ok', title: 'probe reached' });
  }, 90_000);
});
