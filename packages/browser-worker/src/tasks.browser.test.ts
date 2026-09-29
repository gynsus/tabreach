import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPack, parseAdapterPack } from '@tabreach/adapter-packs';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger, uuidv7 } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { redactSnapshot } from './tasks.js';
import { BrowserWorker } from './worker.js';

// Real installed Chrome, headless, against the local fixture site.
const fixturePack = parseAdapterPack({
  id: 'fixture',
  version: '1.0.0',
  channel: 'web_form',
  states: [
    {
      id: 'fixture.account',
      kind: 'logged_in',
      url: ['http://127.0.0.1*/login/account.html'],
      requires: [{ textAny: ['Signed in as'] }],
    },
    {
      id: 'fixture.login',
      kind: 'login',
      url: ['http://127.0.0.1*/login/*'],
      requires: [{ role: 'textbox', name: 'Username' }],
    },
  ],
});

let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(() => fixtures.close());

describe('browser tasks: recognizing pages (Phase 5b)', () => {
  let root: string;
  let profiles: ProfileManager;
  let worker: BrowserWorker;
  let core: RpcPeer;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-tasks-'));
    profiles = new ProfileManager({
      root: join(root, 'profiles'),
      headless: true,
      keychain: false,
      logger: silentLogger,
    });
    const [coreSide, workerSide] = createEndpointPair();
    worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      profiles,
      tasks: {
        diagnosticsDir: join(root, 'diagnostics'),
        pack: (id) => (id === 'fixture' ? fixturePack : bundledPack(id)),
      },
    });
    core = new RpcPeer(coreSide);
  });
  afterEach(async () => {
    worker.close();
    await profiles.closeAll();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const session = async (controlMode: 'automation' | 'human' = 'automation') => {
    const sessionId = uuidv7();
    await core.request(
      'profile.open',
      { profileId: uuidv7(), sessionId, channel: 'chrome', startUrl: null, controlMode },
      { timeoutMs: 60_000 },
    );
    return sessionId;
  };
  const run = (sessionId: string, url: string) =>
    core.request(
      'task.run',
      { taskId: uuidv7(), sessionId, taskType: 'check_state', packId: 'fixture', url },
      { timeoutMs: 60_000 },
    );

  it('a CAPTCHA hands over to a person: needs_human, and the session is paused for automation', async () => {
    const sessionId = await session();
    expect(await run(sessionId, `${fixtures.url}captcha/`)).toMatchObject({
      status: 'needs_human',
      stateId: 'generic.captcha.recaptcha',
      stateKind: 'challenge',
    });
    await expect(run(sessionId, `${fixtures.url}login/`)).rejects.toMatchObject({
      problem: { detail: 'session.notAutomation' },
    });
  });

  it('recognizes a sign-in page and a signed-in page', async () => {
    const sessionId = await session();
    expect(await run(sessionId, `${fixtures.url}login/`)).toMatchObject({
      status: 'succeeded',
      stateKind: 'login',
      stateId: 'fixture.login',
    });
    const page = profiles.contextOf(sessionId)!.pages()[0]!;
    await page.getByLabel('Username').fill('ann');
    await page.getByLabel('Password').fill('x');
    await page.getByRole('button', { name: 'Sign in' }).click();
    expect(await run(sessionId, `${fixtures.url}login/account.html`)).toMatchObject({
      status: 'succeeded',
      stateKind: 'logged_in',
    });
  });

  it('an unknown page is unsupported, with a screenshot and a snapshot to update the pack', async () => {
    const sessionId = await session();
    const result = await run(sessionId, fixtures.url);
    expect(result).toMatchObject({ status: 'unsupported_state', stateId: null, packVersion: '1.0.0' });
    expect(result.diagnostics?.expectedStates).toEqual(
      expect.arrayContaining(['fixture.login', 'generic.captcha.recaptcha']),
    );
    expect(result.diagnostics?.ariaSnapshot).toContain('heading');
    expect(existsSync(join(root, 'diagnostics', result.diagnostics!.screenshot!))).toBe(true);
  }, 60_000);

  it('never acts in a window the person controls', async () => {
    const sessionId = await session('human');
    await expect(run(sessionId, `${fixtures.url}login/`)).rejects.toMatchObject({
      problem: { detail: 'session.notAutomation' },
    });
  });
});

describe('diagnostics redaction', () => {
  it('drops what was typed into fields', () => {
    expect(
      redactSnapshot(
        '- heading "Sign in" [level=1]\n- textbox "Username": ann\n- textbox "Password": secret\n- button "Sign in"',
      ),
    ).toBe(
      '- heading "Sign in" [level=1]\n- textbox "Username": [value]\n- textbox "Password": [value]\n- button "Sign in"',
    );
  });
});
