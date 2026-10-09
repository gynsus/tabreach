import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledPack, parseAdapterPack, type AdapterPack } from '@tabreach/adapter-packs';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import { RpcPeer, silentLogger, uuidv7, type TaskResult, type ThreadReadResult } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { BrowserWorker } from './worker.js';

// The bundled linkedin pack, pointed at the LinkedIn-like fixture pages (Phase 7): the same
// states, controls, actions and reader — only the host differs. Real LinkedIn is checked by hand.
let fixtures: FixtureServer;
let pack: AdapterPack;
beforeAll(async () => {
  fixtures = await startFixtureServer();
  const base = `${fixtures.url}li`;
  pack = parseAdapterPack(
    JSON.parse(JSON.stringify(bundledPack('linkedin')).replaceAll('https://www.linkedin.com', base)),
  );
});
afterAll(() => fixtures.close());

describe('LinkedIn adapter in the worker (Phase 7)', () => {
  let root: string;
  let profiles: ProfileManager;
  let worker: BrowserWorker;
  let core: RpcPeer;
  let sessionId: string;
  let page: Page;
  let checkpoints = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-li-'));
    profiles = new ProfileManager({ root, headless: true, keychain: false, logger: silentLogger });
    const [coreSide, workerSide] = createEndpointPair();
    worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      profiles,
      tasks: {
        diagnosticsDir: join(root, 'diag'),
        pack: (id) => (id === 'linkedin' ? pack : bundledPack(id)),
      },
    });
    checkpoints = 0;
    core = new RpcPeer(coreSide).handle('task.checkpoint', () => {
      checkpoints++;
      return { proceed: true };
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

  const url = (slug: string, query = '') => `${fixtures.url}li/in/${slug}/${query}`;
  const identity = (slug: string, name: string) => ({
    profileUrl: `https://www.linkedin.com/in/${slug}/`,
    name,
  });
  const act = (
    actionId: string,
    slug: string,
    name: string,
    params: Record<string, string> = {},
    query = '',
    mode: 'auto' | 'manual' = 'auto',
  ): Promise<TaskResult> =>
    core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'linkedin',
        url: url(slug, query),
        actionId,
        params,
        mode,
        identity: identity(slug, name),
      },
      { timeoutMs: 90_000 },
    );
  const read = (slug: string, name: string, query = ''): Promise<ThreadReadResult> =>
    core.request(
      'thread.read',
      {
        taskId: uuidv7(),
        sessionId,
        packId: 'linkedin',
        url: url(slug, query),
        readerId: 'linkedin.thread',
        identity: identity(slug, name),
      },
      { timeoutMs: 90_000 },
    );
  const actions = async () =>
    JSON.parse(String(await page.evaluate("localStorage.getItem('li_actions') ?? '[]'"))) as Record<
      string,
      string
    >[];

  it('sends an invitation without and with a note, once each, through the checkpoint', async () => {
    expect(await act('linkedin.connect', 'ann-lee', 'Ann Lee')).toMatchObject({
      status: 'succeeded',
      committed: true,
      packVersion: '0.5.0',
    });
    expect(
      await act('linkedin.connect.note', 'ann-lee', 'Ann Lee', { note: 'Hi Ann, glad to connect.' }),
    ).toMatchObject({
      status: 'succeeded',
      committed: true,
    });
    expect(checkpoints).toBe(2);
    expect((await actions()).map((a) => [a.type, a.note])).toEqual([
      ['invite', ''],
      ['invite', 'Hi Ann, glad to connect.'],
    ]);
  }, 180_000);

  it('never clicks on a page about someone else (FR-LIN-003), or without knowing whom to expect', async () => {
    expect(await act('linkedin.connect', 'ann-lee', 'Anna Leeds')).toMatchObject({
      status: 'unsupported_state',
      errorKey: 'task.identityMismatch',
      committed: false,
    });
    const other = await core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'linkedin',
        url: url('ann-lee'),
        actionId: 'linkedin.connect',
        params: {},
        mode: 'auto',
        identity: identity('bob-first', 'Ann Lee'),
      },
      { timeoutMs: 90_000 },
    );
    expect(other).toMatchObject({ errorKey: 'task.identityMismatch', committed: false });
    const none = await core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'linkedin',
        url: url('ann-lee'),
        actionId: 'linkedin.connect',
        params: {},
        mode: 'auto',
      },
      { timeoutMs: 90_000 },
    );
    expect(none).toMatchObject({ errorKey: 'task.identityRequired', committed: false });
    expect(checkpoints).toBe(0);
    expect(await actions()).toEqual([]);
  }, 180_000);

  it('messages a first-degree connection; no confirmation is unknown, never repeated', async () => {
    expect(await act('linkedin.message', 'bob-first', 'Bob First', { body: 'Hello Bob' })).toMatchObject({
      status: 'succeeded',
      committed: true,
    });
    expect(
      await act('linkedin.message', 'bob-first', 'Bob First', { body: 'Second' }, '?result=silent'),
    ).toMatchObject({
      status: 'unknown',
      committed: true,
    });
    // Older messages loading into the thread are not a new one of ours (live check, 2026-10-09).
    expect(
      await act(
        'linkedin.message',
        'bob-first',
        'Bob First',
        { body: 'Third' },
        '?thread=older&result=silent',
      ),
    ).toMatchObject({ status: 'unknown', committed: true });
    // A first message, where there is no conversation yet.
    expect(
      await act('linkedin.message', 'bob-first', 'Bob First', { body: 'First' }, '?thread=none'),
    ).toMatchObject({ status: 'succeeded', committed: true });
    expect((await actions()).map((a) => a.body)).toEqual(['Hello Bob', 'Second', 'Third', 'First']);
  }, 180_000);

  it('manual: opens the conversation or the invitation, passes the checkpoint, types and presses nothing (ADR 015)', async () => {
    expect(
      await act('linkedin.message', 'bob-first', 'Bob First', { body: 'Hello Bob' }, '', 'manual'),
    ).toMatchObject({
      status: 'unknown',
      committed: true,
      errorKey: 'task.manual',
      stateId: 'linkedin.messaging',
    });
    expect(await page.getByRole('main').getByRole('textbox').textContent()).toBe('');
    expect(
      await act('linkedin.connect.note', 'ann-lee', 'Ann Lee', { note: 'Hi' }, '', 'manual'),
    ).toMatchObject({
      status: 'unknown',
      errorKey: 'task.manual',
      stateId: 'linkedin.invite.note', // the note's field open, for the person to paste into
    });
    // Someone else's page is still never handed over as theirs.
    expect(await act('linkedin.connect', 'ann-lee', 'Anna Leeds', {}, '', 'manual')).toMatchObject({
      errorKey: 'task.identityMismatch',
      committed: false,
    });
    expect(checkpoints).toBe(2);
    expect(await actions()).toEqual([]);
  }, 180_000);

  it('reads whether the person answered, without sending anything (FR-LIN-004)', async () => {
    expect(await read('bob-first', 'Bob First')).toMatchObject({
      status: 'ok',
      replied: false,
      messages: [{ direction: 'out' }],
    });
    expect(await read('bob-first', 'Bob First', '?thread=replied')).toMatchObject({
      status: 'ok',
      replied: true,
      messages: [{ direction: 'out' }, { direction: 'in' }],
    });
    expect(await read('bob-first', 'Bob First', '?thread=none')).toMatchObject({
      status: 'ok',
      replied: false,
      messages: [],
    });
    // Their conversation is there but cannot be read: not "no messages" (fails closed).
    expect(await read('bob-first', 'Bob First', '?thread=unreadable')).toMatchObject({
      status: 'unsupported_state',
      stateId: 'linkedin.messaging',
    });
    expect(await read('bob-first', 'Someone Else')).toMatchObject({
      status: 'unsupported_state',
      errorKey: 'task.identityMismatch',
    });
    expect(await actions()).toEqual([]);
    expect(checkpoints).toBe(0);
  }, 180_000);

  it('a pending invitation or a sign-in wall is not a page to act on', async () => {
    expect(await act('linkedin.connect', 'cara-pending', 'Cara Pending')).toMatchObject({
      status: 'unsupported_state',
      stateId: 'linkedin.profile.pending',
      committed: false,
    });
    // Not connected yet: a message is not possible, and the page says why.
    expect(await act('linkedin.message', 'ann-lee', 'Ann Lee', { body: 'x' })).toMatchObject({
      status: 'unsupported_state',
      stateId: 'linkedin.profile.connectable',
    });
    expect(await read('ann-lee', 'Ann Lee')).toMatchObject({
      status: 'unsupported_state',
      stateId: 'linkedin.profile.connectable',
    });
    const wall = await core.request(
      'task.run',
      {
        taskId: uuidv7(),
        sessionId,
        taskType: 'commit',
        packId: 'linkedin',
        url: `${fixtures.url}li/authwall/`,
        actionId: 'linkedin.connect',
        params: {},
        mode: 'auto',
        identity: identity('ann-lee', 'Ann Lee'),
      },
      { timeoutMs: 90_000 },
    );
    expect(wall).toMatchObject({ errorKey: 'task.loginRequired', stateKind: 'login', committed: false });
    expect(checkpoints).toBe(0);
  }, 180_000);
});
