import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchCheck } from './launch-check.js';
import { BrowserWorker } from './worker.js';

// Real installed Google Chrome against a local fixture site; never a live third-party site in CI.
let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(async () => {
  await fixtures.close();
});

describe('launchCheck (installed Chrome)', () => {
  it('loads a fixture page with a throwaway persistent profile', async () => {
    const result = await launchCheck(fixtures.url, { headless: true, logger: silentLogger });
    expect(result).toMatchObject({ ok: true, httpStatus: 200, title: 'TabReach Fixture Home' });
    expect(result.chromeVersion).toMatch(/^\d+\./);
  });

  it('reports a failed navigation instead of throwing', async () => {
    const result = await launchCheck(`${fixtures.url}missing.html`, { headless: true, logger: silentLogger });
    expect(result).toMatchObject({ ok: false, httpStatus: 404 });
  });
});

describe('BrowserWorker over the browser protocol', () => {
  it('answers health and launch checks from core', async () => {
    const [coreSide, workerSide] = createEndpointPair();
    const worker = new BrowserWorker({ core: workerSide, logger: silentLogger, launch: { headless: true } });
    const core = new RpcPeer(coreSide);

    const health = await core.request('worker.health', {});
    expect(health).toMatchObject({ status: 'ok', chrome: { installed: true } });
    expect(health.playwright).toMatch(/^\d+\.\d+\.\d+$/);

    await expect(
      core.request('worker.launchCheck', { url: fixtures.url }, { timeoutMs: 60_000 }),
    ).resolves.toMatchObject({
      ok: true,
      title: 'TabReach Fixture Home',
    });
    worker.close();
  });

  it('refuses a launch check with BROWSER_CHROME_NOT_FOUND when Chrome is missing', async () => {
    const [coreSide, workerSide] = createEndpointPair();
    const worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      chromeLocations: ['/nonexistent/Chrome.app'],
    });
    await expect(
      new RpcPeer(coreSide).request('worker.launchCheck', { url: fixtures.url }),
    ).rejects.toMatchObject({
      problem: { code: 'BROWSER_CHROME_NOT_FOUND' },
    });
    expect((await worker.health()).status).toBe('degraded');
    worker.close();
  });
});
