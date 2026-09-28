import { describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from './envelope.js';
import { uuidv7 } from './ids.js';
import { RpcError, RpcPeer } from './rpc.js';
import { createEndpointPair } from './testing.js';

const launchResult = {
  ok: true,
  url: 'https://example.com',
  httpStatus: 200,
  title: 'Example Domain',
  chromeVersion: '154.0.0.0',
  durationMs: 900,
};

function peers(opts: ConstructorParameters<typeof RpcPeer>[1] = {}) {
  const [a, b] = createEndpointPair();
  return { client: new RpcPeer(a, opts), server: new RpcPeer(b, opts), rawClient: a };
}

describe('uuidv7', () => {
  it('keeps creation order within one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => uuidv7(1_800_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  it('produces RFC 9562 version 7 ids ordered by time', () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first < second).toBe(true);
  });
});

describe('RpcPeer', () => {
  it('round-trips a validated request and response', async () => {
    const { client, server } = peers();
    server.handle('worker.launchCheck', ({ url }) => ({ ...launchResult, url }));
    await expect(client.request('worker.launchCheck', { url: 'https://example.com' })).resolves.toEqual(
      launchResult,
    );
  });

  it('propagates the correlation id to the handler', async () => {
    const { client, server } = peers();
    const seen = vi.fn();
    server.handle('worker.launchCheck', (_p, ctx) => {
      seen(ctx.correlationId);
      return launchResult;
    });
    const correlationId = uuidv7();
    await client.request('worker.launchCheck', { url: 'https://example.com' }, { correlationId });
    expect(seen).toHaveBeenCalledWith(correlationId);
  });

  it('rejects an invalid request payload with VALIDATION_FAILED', async () => {
    const { client, server } = peers();
    server.handle('worker.launchCheck', () => launchResult);
    const error = await client
      .request('worker.launchCheck', { url: 'javascript:alert(1)' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).problem.code).toBe('VALIDATION_FAILED');
  });

  it('returns schema messages that are translation keys as field errors', async () => {
    const { client, server } = peers();
    server.handle('accounts.connectGmail', () => {
      throw new Error('handler must not run');
    });
    const error = (await client
      .request('accounts.connectGmail', { clientId: 'not-a-client-id' })
      .catch((e: unknown) => e)) as RpcError;
    expect(error.problem).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: { clientId: 'oauth.clientIdInvalid' },
    });
  });

  it('answers requests without a handler with UNKNOWN_MESSAGE_TYPE', async () => {
    const { client } = peers();
    const error = await client.request('worker.health', {}).catch((e: unknown) => e);
    expect((error as RpcError).problem.code).toBe('UNKNOWN_MESSAGE_TYPE');
  });

  it('answers unknown types sent on the wire with UNKNOWN_MESSAGE_TYPE', async () => {
    const [a, b] = createEndpointPair();
    new RpcPeer(b);
    const replies: unknown[] = [];
    a.onMessage((m) => replies.push(m));
    const id = uuidv7();
    a.postMessage({
      id,
      kind: 'command',
      type: 'profile.deleteEverything',
      schemaVersion: SCHEMA_VERSION,
      correlationId: uuidv7(),
      sentAt: new Date().toISOString(),
      payload: {},
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      kind: 'result',
      causationId: id,
      payload: { ok: false, error: { code: 'UNKNOWN_MESSAGE_TYPE' } },
    });
  });

  it('rejects an unsupported schema version', async () => {
    const [a, b] = createEndpointPair();
    new RpcPeer(b).handle('worker.health', () => {
      throw new Error('must not run');
    });
    const replies: unknown[] = [];
    a.onMessage((m) => replies.push(m));
    a.postMessage({
      id: uuidv7(),
      kind: 'query',
      type: 'worker.health',
      schemaVersion: 99,
      correlationId: uuidv7(),
      sentAt: new Date().toISOString(),
      payload: {},
    });
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(replies[0]).toMatchObject({
      payload: { ok: false, error: { code: 'UNSUPPORTED_SCHEMA_VERSION' } },
    });
  });

  it('reports malformed envelopes instead of answering them', async () => {
    const onInvalid = vi.fn();
    const [a, b] = createEndpointPair();
    new RpcPeer(b, { onInvalid });
    a.postMessage({ hello: 'world' });
    await vi.waitFor(() => expect(onInvalid).toHaveBeenCalledWith('malformed envelope', { hello: 'world' }));
  });

  it('hides internal error details from the caller and reports them locally', async () => {
    const onHandlerError = vi.fn();
    const { client, server } = peers({ onHandlerError });
    server.handle('worker.launchCheck', () => {
      throw new Error('secret stack detail');
    });
    const error = (await client
      .request('worker.launchCheck', { url: 'https://example.com' })
      .catch((e: unknown) => e)) as RpcError;
    expect(error.problem).toEqual({
      code: 'INTERNAL',
      title: 'Internal error',
      detail: 'worker.launchCheck',
    });
    expect(onHandlerError).toHaveBeenCalledOnce();
  });

  it('passes RpcError problems through unchanged', async () => {
    const { client, server } = peers();
    server.handle('worker.launchCheck', () => {
      throw new RpcError('BROWSER_CHROME_NOT_FOUND', 'Google Chrome is not installed');
    });
    const error = (await client
      .request('worker.launchCheck', { url: 'https://example.com' })
      .catch((e: unknown) => e)) as RpcError;
    expect(error.problem.code).toBe('BROWSER_CHROME_NOT_FOUND');
  });

  it('rejects a response that fails the response schema', async () => {
    const { client, server } = peers();
    server.handle('worker.launchCheck', () => ({ nonsense: true }) as unknown as typeof launchResult);
    const error = (await client
      .request('worker.launchCheck', { url: 'https://example.com' })
      .catch((e: unknown) => e)) as RpcError;
    expect(error.problem.code).toBe('INVALID_MESSAGE');
  });

  it('times out when nobody answers', async () => {
    const [a] = createEndpointPair();
    const client = new RpcPeer(a);
    const error = (await client
      .request('worker.health', {}, { timeoutMs: 20 })
      .catch((e: unknown) => e)) as RpcError;
    expect(error.problem.code).toBe('TIMEOUT');
  });

  it('delivers validated events to subscribers and reports invalid ones', async () => {
    const onInvalid = vi.fn();
    const [a, b] = createEndpointPair();
    const sender = new RpcPeer(a);
    const receiver = new RpcPeer(b, { onInvalid });
    const got = vi.fn();
    const off = receiver.on('data.changed', got);
    sender.emit('data.changed', { entities: ['contact'] });
    await vi.waitFor(() => expect(got).toHaveBeenCalledWith({ entities: ['contact'] }, expect.anything()));
    a.postMessage({
      id: uuidv7(),
      kind: 'event',
      type: 'data.changed',
      schemaVersion: SCHEMA_VERSION,
      correlationId: uuidv7(),
      sentAt: new Date().toISOString(),
      payload: { entities: [] },
    });
    await vi.waitFor(() =>
      expect(onInvalid).toHaveBeenCalledWith('invalid data.changed payload', expect.anything()),
    );
    off();
    sender.emit('data.changed', { entities: ['company'] });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveBeenCalledTimes(1);
  });

  it('passes the idempotency key to the handler', async () => {
    const { client, server } = peers();
    const seen = vi.fn();
    server.handle('worker.launchCheck', (_p, ctx) => {
      seen(ctx.idempotencyKey);
      return launchResult;
    });
    const key = uuidv7();
    await client.request('worker.launchCheck', { url: 'https://example.com' }, { idempotencyKey: key });
    expect(seen).toHaveBeenCalledWith(key);
  });

  it('fails fast with UNAVAILABLE when the port throws on send', async () => {
    const client = new RpcPeer({
      postMessage() {
        throw new Error('port closed');
      },
      onMessage: () => () => {},
    });
    const error = (await client.request('worker.health', {}).catch((e: unknown) => e)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.problem.code).toBe('UNAVAILABLE');
  });

  it('does not answer after it was closed while a handler ran', async () => {
    const [a, b] = createEndpointPair();
    const server = new RpcPeer(b);
    let release = () => {};
    server.handle(
      'worker.health',
      () =>
        new Promise(
          (r) =>
            (release = () =>
              r({
                status: 'ok',
                node: '24',
                playwright: '1',
                chrome: { installed: false, version: null, path: null },
              })),
        ),
    );
    const replies: unknown[] = [];
    a.onMessage((m) => replies.push(m));
    a.postMessage({
      id: uuidv7(),
      kind: 'query',
      type: 'worker.health',
      schemaVersion: SCHEMA_VERSION,
      correlationId: uuidv7(),
      sentAt: new Date().toISOString(),
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 5));
    server.close();
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(replies).toEqual([]);
  });

  it('rejects pending requests when closed', async () => {
    const [a] = createEndpointPair();
    const client = new RpcPeer(a);
    const pending = client.request('worker.health', {}).catch((e: unknown) => e);
    client.close();
    expect(((await pending) as RpcError).problem.code).toBe('UNAVAILABLE');
  });
});
