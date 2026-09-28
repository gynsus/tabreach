import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';

// Smoke test of the built app (out/): all processes start and the status screen reports them.
let app: ElectronApplication;
let userData: string;
let fixtures: FixtureServer;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'tabreach-e2e-'));
  fixtures = await startFixtureServer();
  app = await electron.launch({
    args: [join(import.meta.dirname, '..')],
    env: { ...process.env, TABREACH_USER_DATA_DIR: userData },
  });
});

test.afterAll(async () => {
  await app?.close();
  await fixtures?.close();
  rmSync(userData, { recursive: true, force: true });
});

test('status screen shows core, database, secret storage and worker working', async () => {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'System status' })).toBeVisible();
  for (const id of ['core', 'database', 'secrets', 'worker', 'chrome']) {
    await expect(page.getByTestId(`component-${id}`)).toHaveAttribute('data-status', 'ok', {
      timeout: 20_000,
    });
  }
  await expect(page.getByTestId('component-database')).toContainText('schema version 2');
});

test('renderer has no Node access and cannot reach host or browser channels', async () => {
  const page = await app.firstWindow();
  const probe = await page.evaluate(async () => {
    const bridge = (window as unknown as { tabreach: unknown }).tabreach as {
      invoke(type: string, payload: unknown): Promise<{ ok: boolean; error?: { code: string } }>;
    };
    const secret = await bridge.invoke('secret.decrypt', { ciphertext: 'AAAA' });
    const worker = await bridge.invoke('worker.launchCheck', { url: 'https://example.com' });
    return {
      hasRequire: typeof (globalThis as { require?: unknown }).require !== 'undefined',
      hasProcess: typeof (globalThis as { process?: unknown }).process !== 'undefined',
      secret: secret.error?.code,
      worker: worker.error?.code,
    };
  });
  expect(probe).toEqual({
    hasRequire: false,
    hasProcess: false,
    secret: 'UNKNOWN_MESSAGE_TYPE',
    worker: 'UNKNOWN_MESSAGE_TYPE',
  });
});

test('launch check travels renderer -> core -> worker -> Chrome and back', async () => {
  const page = await app.firstWindow();
  const result = await page.evaluate(async (url) => {
    const bridge = (window as unknown as { tabreach: { invoke(t: string, p: unknown): Promise<unknown> } })
      .tabreach;
    return bridge.invoke('browser.launchCheck', { url });
  }, fixtures.url);
  expect(result).toMatchObject({
    ok: true,
    data: { ok: true, httpStatus: 200, title: 'TabReach Fixture Home' },
  });
});
