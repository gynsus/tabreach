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

  it('rejects pending requests when closed', async () => {
    const [a] = createEndpointPair();
    const client = new RpcPeer(a);
    const pending = client.request('worker.health', {}).catch((e: unknown) => e);
    client.close();
    expect(((await pending) as RpcError).problem.code).toBe('UNAVAILABLE');
  });
});
