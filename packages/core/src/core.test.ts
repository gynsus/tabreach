import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcError, RpcPeer, silentLogger, uuidv7, type WorkerHealth } from '@tabreach/protocol';
import { createEndpointPair } from '@tabreach/protocol/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CoreService } from './core.js';
import { openDatabase } from './db/database.js';
import { migrate } from './db/migrate.js';
import { migrations } from './db/migrations.js';
import { SecretStore, type SecretCipher } from './secrets/secrets.js';
import { SettingsRepository } from './settings/settings.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tabreach-core-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Stand-in for main's safeStorage: reversible, and visibly not plaintext. */
const fakeCipher: SecretCipher = {
  encrypt: async (p) => Buffer.from(`enc:${p}`).toString('base64'),
  decrypt: async (c) => Buffer.from(c, 'base64').toString().replace(/^enc:/, ''),
};

function fakeHost() {
  const [coreSide, hostSide] = createEndpointPair();
  new RpcPeer(hostSide)
    .handle('secret.encrypt', async ({ plaintext }) => ({ ciphertext: await fakeCipher.encrypt(plaintext) }))
    .handle('secret.decrypt', async ({ ciphertext }) => ({
      plaintext: await fakeCipher.decrypt(ciphertext),
    }));
  return coreSide;
}

const workerHealth: WorkerHealth = {
  status: 'ok',
  node: '24.21.0',
  playwright: '1.63.0',
  chrome: { installed: true, version: '154.0.8037.57', path: '/Applications/Google Chrome.app' },
};

async function startCore() {
  return CoreService.start({
    dataDir: dir,
    appVersion: '0.0.0-test',
    electronVersion: null,
    host: fakeHost(),
    logger: silentLogger,
  });
}

describe('CoreService', () => {
  it('runs a campaign end to end through the app protocol', async () => {
    const core = await startCore();
    const [rendererSide, coreSide] = createEndpointPair();
    core.attachApp(coreSide);
    const app = new RpcPeer(rendererSide);
    const contact = await app.request('contacts.create', { firstName: 'Ann', email: 'ann@acme.test' });
    const campaign = await app.request('campaigns.create', {
      name: 'Hello',
      config: {
        steps: [
          {
            type: 'send_message',
            channel: 'test',
            executionMode: 'auto',
            delaySeconds: 0,
            subject: 'Hi',
            body: 'Hi {{firstName}}',
          },
        ],
        timezone: 'UTC',
        window: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' },
        approvalMode: 'approve_each',
      },
    });
    await app.request('campaigns.launch', { id: campaign.id });
    const key = uuidv7();
    const enroll = { campaignId: campaign.id, contactIds: [contact.id] };
    expect(await app.request('campaigns.enroll', enroll, { idempotencyKey: key })).toMatchObject({
      enrolled: 1,
    });
    expect(await app.request('campaigns.enroll', enroll, { idempotencyKey: key })).toMatchObject({
      enrolled: 1,
    });

    await expect.poll(async () => (await app.request('approvals.pending', {})).items).toHaveLength(1);
    const [approval] = (await app.request('approvals.pending', {})).items;
    expect(approval).toMatchObject({ body: 'Hi Ann', target: 'ann@acme.test' });
    await expect(
      app.request('approvals.approve', { approvalId: approval?.id as string, contentHash: '0'.repeat(64) }),
    ).rejects.toMatchObject({ problem: { code: 'APPROVAL_STALE' } });
    await app.request('approvals.approve', {
      approvalId: approval?.id as string,
      contentHash: approval?.contentHash as string,
    });
    await expect
      .poll(async () => (await app.request('enrollments.list', { campaignId: campaign.id })).items[0]?.status)
      .toBe('completed');
    core.close();
  });

  it('runs enqueued jobs right away and tells windows about failures', async () => {
    const core = await startCore();
    const [rendererSide, coreSide] = createEndpointPair();
    core.attachApp(coreSide);
    const changed: string[][] = [];
    new RpcPeer(rendererSide).on('data.changed', ({ entities }) => void changed.push(entities));
    const ran = new Promise<string>((resolve) => {
      core.dispatcher.register({
        type: 'test.echo',
        payload: z.object({ text: z.string() }),
        sideEffecting: false,
        handler: ({ text }) => resolve(text),
      });
    });
    core.services.jobs.enqueue('test.echo', { text: 'hello' });
    expect(await ran).toBe('hello');

    core.services.jobs.enqueue('test.unregistered', {});
    await expect.poll(() => changed).toContainEqual(['job', 'enrollment']);
    core.close();
  });

  it('reports healthy database and secret storage, and a missing worker as down', async () => {
    const core = await startCore();
    const [rendererSide, coreSide] = createEndpointPair();
    core.attachApp(coreSide);
    const health = await new RpcPeer(rendererSide).request('app.health', {});
    expect(health.database).toMatchObject({ status: 'ok', schemaVersion: migrations.length });
    expect(health.secrets).toEqual({ status: 'ok' });
    expect(health.worker).toEqual({ status: 'down', detail: 'worker.notRunning' });
    core.close();
  });

  it('includes worker health and forwards launch checks to the worker', async () => {
    const core = await startCore();
    const [coreToWorker, workerSide] = createEndpointPair();
    new RpcPeer(workerSide)
      .handle('worker.health', () => workerHealth)
      .handle('worker.launchCheck', ({ url }) => ({
        ok: true,
        url,
        httpStatus: 200,
        title: 'Example Domain',
        chromeVersion: '154.0.8037.57',
        durationMs: 800,
      }));
    core.attachWorker(coreToWorker);

    const [rendererSide, coreSide] = createEndpointPair();
    core.attachApp(coreSide);
    const renderer = new RpcPeer(rendererSide);
    expect((await renderer.request('app.health', {})).worker).toEqual(workerHealth);
    await expect(
      renderer.request('browser.launchCheck', { url: 'https://example.com' }),
    ).resolves.toMatchObject({
      ok: true,
      title: 'Example Domain',
    });
    core.close();
  });

  it('reports UNAVAILABLE for a launch check without a worker', async () => {
    const core = await startCore();
    const [rendererSide, coreSide] = createEndpointPair();
    core.attachApp(coreSide);
    await expect(
      new RpcPeer(rendererSide).request('browser.launchCheck', { url: 'https://example.com' }),
    ).rejects.toMatchObject({ problem: { code: 'UNAVAILABLE' } });
    core.close();
  });

  it('marks secret storage down when main cannot encrypt, and still starts', async () => {
    const [coreSide, hostSide] = createEndpointPair();
    new RpcPeer(hostSide).handle('secret.encrypt', () => {
      throw new RpcError('UNAVAILABLE', 'Encryption is not available');
    });
    const core = await CoreService.start({
      dataDir: dir,
      appVersion: '0.0.0-test',
      electronVersion: null,
      host: coreSide,
      logger: silentLogger,
    });
    expect((await core.health()).secrets).toEqual({
      status: 'down',
      detail: 'secrets.encryptionUnavailable',
    });
    core.close();
  });
});

describe('SecretStore', () => {
  it('stores only ciphertext and reveals the original', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, migrations, { backupDir: join(dir, 'backups') });
    const store = new SecretStore(db, fakeCipher);
    const id = await store.put('ai_api_key', 'sk-test-123');
    const raw = db.prepare('SELECT ciphertext FROM secrets WHERE id = ?').get(id) as {
      ciphertext: Uint8Array;
    };
    expect(Buffer.from(raw.ciphertext).toString()).not.toBe('sk-test-123');
    expect(await store.reveal(id)).toBe('sk-test-123');
    store.delete(id);
    await expect(store.reveal(id)).rejects.toThrow(/not found/);
    db.close();
  });
});

describe('SettingsRepository', () => {
  it('round-trips validated JSON values', async () => {
    const db = openDatabase(join(dir, 'app.db'));
    await migrate(db, migrations, { backupDir: join(dir, 'backups') });
    const settings = new SettingsRepository(db);
    const schema = z.object({ keepAwake: z.boolean() });
    expect(settings.get('app.power', schema)).toBeUndefined();
    settings.set('app.power', { keepAwake: true });
    settings.set('app.power', { keepAwake: false });
    expect(settings.get('app.power', schema)).toEqual({ keepAwake: false });
    settings.set('app.power', { keepAwake: 'yes' });
    // An invalid stored value falls back to defaults (undefined) instead of failing forever.
    expect(settings.get('app.power', schema)).toBeUndefined();
    db.close();
  });
});
