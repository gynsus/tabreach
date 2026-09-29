import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORM_FIELDS } from '@tabreach/adapter-packs';
import { startFixtureServer, type FixtureServer } from '@tabreach/fixture-sites';
import {
  formFieldMeaningSchema,
  RpcPeer,
  silentLogger,
  uuidv7,
  type FormPrepareResult,
  type TaskResult,
} from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileManager } from './profiles.js';
import { BrowserWorker } from './worker.js';

// Real installed Chrome against the fixture contact forms (Phase 6 exit criteria).
const values = {
  name: 'Anna Test',
  firstName: 'Anna',
  lastName: 'Test',
  email: 'anna@sender.test',
  company: 'Sender Co',
  subject: 'Hello',
  message: 'Hello from TabReach',
};

let fixtures: FixtureServer;
beforeAll(async () => {
  fixtures = await startFixtureServer();
});
afterAll(() => fixtures.close());

describe('website forms (Phase 6)', () => {
  let root: string;
  let profiles: ProfileManager;
  let worker: BrowserWorker;
  let core: RpcPeer;
  let sessionId: string;
  let page: Page;
  let proceed = true;
  let checkpoints = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tabreach-forms-'));
    profiles = new ProfileManager({ root, headless: true, keychain: false, logger: silentLogger });
    const [coreSide, workerSide] = createEndpointPair();
    worker = new BrowserWorker({
      core: workerSide,
      logger: silentLogger,
      profiles,
      tasks: { diagnosticsDir: join(root, 'diag') },
    });
    proceed = true;
    checkpoints = 0;
    core = new RpcPeer(coreSide).handle('task.checkpoint', () => {
      checkpoints++;
      return { proceed };
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

  const prepare = (path: string): Promise<FormPrepareResult> =>
    core.request(
      'form.prepare',
      { taskId: uuidv7(), sessionId, url: `${fixtures.url}${path}`, values },
      { timeoutMs: 60_000 },
    );
  const submit = (
    prepared: FormPrepareResult,
    over: { signature?: string; mode?: 'auto' | 'assisted' } = {},
  ): Promise<TaskResult> =>
    core.request(
      'form.submit',
      {
        taskId: uuidv7(),
        sessionId,
        formUrl: prepared.formUrl!,
        opener: prepared.opener,
        signature: over.signature ?? prepared.signature!,
        fields: prepared.fields.filter((f) => f.value !== null).map((f) => ({ ref: f.ref, value: f.value! })),
        mode: over.mode ?? 'auto',
      },
      { timeoutMs: 60_000 },
    );
  const submissions = async () =>
    JSON.parse(String(await page.evaluate("localStorage.getItem('fixture_submissions') ?? '[]'"))) as {
      values: Record<string, string | boolean>;
    }[];
  const byMeaning = (r: FormPrepareResult) =>
    Object.fromEntries(r.fields.map((f) => [f.label, [f.meaning, f.value]]));

  it('the pack and the protocol know the same field meanings', () => {
    expect([...FORM_FIELDS]).toEqual(formFieldMeaningSchema.options);
  });

  it('finds the contact page from the home page, skips the login form, never ticks a consent', async () => {
    const r = await prepare('forms/index.html');
    expect(r).toMatchObject({ status: 'ready', reason: null, opener: null, challenge: null });
    expect(r.formUrl).toBe(`${fixtures.url}forms/contact.html`);
    expect(byMeaning(r)).toEqual({
      'Your name': ['name', 'Anna Test'],
      Email: ['email', 'anna@sender.test'],
      Company: ['company', 'Sender Co'],
      Subject: ['subject', 'Hello'],
      Message: ['message', 'Hello from TabReach'],
      'Send me marketing emails and news': ['consent', null],
    });
    expect(r.screenshot?.length).toBeGreaterThan(1000);
    expect(await submissions()).toEqual([]); // prepared, not sent
  }, 90_000);

  it('reads a form drawn by a script, by placeholders; opens a form in a dialog', async () => {
    expect(byMeaning(await prepare('forms/dynamic.html'))).toEqual({
      'Full name': ['name', 'Anna Test'],
      'Work email': ['email', 'anna@sender.test'],
      Phone: ['phone', null],
      'How can we help?': ['message', 'Hello from TabReach'],
    });
    const modal = await prepare('forms/modal.html');
    expect(modal).toMatchObject({ status: 'ready', opener: 'Contact us' });
  }, 90_000);

  it('asks the person for a required field it cannot fill, a required consent, or a CAPTCHA', async () => {
    const unmapped = await prepare('forms/unmapped.html');
    expect(unmapped).toMatchObject({ status: 'needs_human', reason: 'form.unmappedRequired' });
    expect(byMeaning(unmapped)['Order number']).toEqual([null, null]);

    const ru = await prepare('forms/ru.html');
    expect(ru).toMatchObject({ status: 'needs_human', reason: 'form.consentRequired' });
    expect(byMeaning(ru)).toMatchObject({
      Имя: ['firstName', 'Anna'],
      Фамилия: ['lastName', 'Test'],
      'Электронная почта': ['email', 'anna@sender.test'],
      Сообщение: ['message', 'Hello from TabReach'],
      'Согласие на обработку персональных данных': ['consent', null],
    });

    const captcha = await prepare('forms/captcha.html');
    expect(captcha).toMatchObject({
      status: 'needs_human',
      reason: 'form.challenge',
      challenge: 'generic.captcha.recaptcha',
    });
    // Auto never sends a form with a CAPTCHA: nothing pressed, no checkpoint.
    expect(await submit(captcha)).toMatchObject({
      status: 'needs_human',
      errorKey: 'form.challenge',
      committed: false,
    });
    expect(checkpoints).toBe(0);
    expect(await submissions()).toEqual([]);
  }, 120_000);

  it('sends once through the checkpoint and recognizes a thank-you page or message', async () => {
    const thanks = await prepare('forms/contact.html?result=thanks');
    expect(await submit(thanks)).toMatchObject({ status: 'succeeded', committed: true });
    const inline = await prepare('forms/contact.html?result=inline');
    expect(await submit(inline)).toMatchObject({ status: 'succeeded', committed: true });
    expect(checkpoints).toBe(2);
    const sent = await submissions();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.values).toMatchObject({
      'your-name': 'Anna Test',
      'your-email': 'anna@sender.test',
      'your-message': 'Hello from TabReach',
      newsletter: false,
    });
  }, 120_000);

  it('a refusal on the form is verified "not sent"; no confirmation is unknown', async () => {
    expect(await submit(await prepare('forms/contact.html?result=reject'))).toMatchObject({
      status: 'failed',
      errorKey: 'task.rejected',
      committed: true,
    });
    expect(await submit(await prepare('forms/contact.html?result=silent'))).toMatchObject({
      status: 'unknown',
      committed: true,
    });
    expect(await submissions()).toHaveLength(2);
  }, 120_000);

  it('never presses a form that changed since approval, or when the checkpoint is refused', async () => {
    const r = await prepare('forms/contact.html?result=thanks');
    expect(await submit(r, { signature: 'f'.repeat(64) })).toMatchObject({
      status: 'unsupported_state',
      errorKey: 'form.changed',
      committed: false,
    });
    proceed = false;
    expect(await submit(r)).toMatchObject({ errorKey: 'task.checkpointRefused', committed: false });
    expect(await submissions()).toEqual([]);
  }, 120_000);

  it('a dialog form is opened again and sent', async () => {
    const r = await prepare('forms/modal.html?result=inline');
    expect(await submit(r)).toMatchObject({ status: 'succeeded', committed: true });
    expect(await submissions()).toHaveLength(1);
  }, 90_000);
});
