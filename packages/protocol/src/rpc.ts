import { z } from 'zod';
import {
  SCHEMA_VERSION,
  envelopeSchema,
  resultPayloadSchema,
  type Envelope,
  type ErrorCode,
  type Problem,
  type ResultPayload,
} from './envelope.js';
import { events, isEventType, type EventPayloadOf, type EventType } from './events.js';
import { uuidv7 } from './ids.js';
import { isRequestType, requests, type RequestOf, type RequestType, type ResponseOf } from './messages.js';

/** Transport-agnostic message endpoint (MessagePort, parentPort, test double). */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
}

export class RpcError extends Error {
  readonly problem: Problem;

  constructor(code: ErrorCode, title: string, detail?: string, fields?: Record<string, string>) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = 'RpcError';
    this.problem = {
      code,
      title,
      ...(detail === undefined ? {} : { detail }),
      ...(fields === undefined ? {} : { fields }),
    };
  }

  /** Validation failure with per-field message keys for the UI to translate. */
  static validation(fields: Record<string, string>, detail?: string): RpcError {
    return new RpcError('VALIDATION_FAILED', 'Validation failed', detail, fields);
  }
}

export interface HandlerContext {
  envelope: Envelope;
  correlationId: string;
  /** Present when the caller sent one; handlers of creating commands must honour it (ADR 020). */
  idempotencyKey: string | undefined;
}

type Handler<T extends RequestType> = (
  payload: z.output<(typeof requests)[T]['request']>,
  ctx: HandlerContext,
) => Promise<ResponseOf<T>> | ResponseOf<T>;

type EventListener<T extends EventType> = (payload: EventPayloadOf<T>, envelope: Envelope) => void;

export interface RpcPeerOptions {
  /** Default request timeout. */
  timeoutMs?: number;
  /** Called for messages that cannot be answered (malformed envelopes, stray results, bad events). */
  onInvalid?: (reason: string, raw: unknown) => void;
  /** Called when a handler or event listener throws something other than RpcError. */
  onHandlerError?: (type: string, error: unknown) => void;
}

export interface RequestOptions {
  correlationId?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
}

interface Pending {
  type: RequestType;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private readonly handlers = new Map<RequestType, Handler<RequestType>>();
  private readonly listeners = new Map<EventType, Set<EventListener<EventType>>>();
  private readonly pending = new Map<string, Pending>();
  private readonly unsubscribe: () => void;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly endpoint: MessageEndpoint,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.unsubscribe = endpoint.onMessage((raw) => {
      this.receive(raw).catch((error: unknown) => this.options.onHandlerError?.('receive', error));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  handle<T extends RequestType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as Handler<RequestType>);
    return this;
  }

  /** Subscribes to an event type; returns the unsubscribe function. */
  on<T extends EventType>(type: T, listener: EventListener<T>): () => void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener as unknown as EventListener<EventType>);
    this.listeners.set(type, set);
    return () => set.delete(listener as unknown as EventListener<EventType>);
  }

  /** Fire-and-forget notification to the other side. Dropped silently once the channel is closed. */
  emit<T extends EventType>(
    type: T,
    payload: EventPayloadOf<T>,
    opts: { correlationId?: string } = {},
  ): void {
    if (this.closed) return;
    this.send({
      id: uuidv7(),
      kind: 'event',
      type,
      schemaVersion: SCHEMA_VERSION,
      correlationId: opts.correlationId ?? uuidv7(),
      sentAt: new Date().toISOString(),
      payload,
    });
  }

  request<T extends RequestType>(
    type: T,
    payload: RequestOf<T>,
    opts: RequestOptions = {},
  ): Promise<ResponseOf<T>> {
    if (this.closed) {
      return Promise.reject(new RpcError('UNAVAILABLE', 'Channel closed', type));
    }
    const envelope: Envelope = {
      id: uuidv7(),
      kind: requests[type].kind,
      type,
      schemaVersion: SCHEMA_VERSION,
      correlationId: opts.correlationId ?? uuidv7(),
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      sentAt: new Date().toISOString(),
      payload,
    };
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new RpcError('TIMEOUT', 'Request timed out', type));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(envelope.id, { type, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.endpoint.postMessage(envelope);
      } catch {
        // A closed port or an uncloneable payload: fail now instead of waiting for the timeout.
        clearTimeout(timer);
        this.pending.delete(envelope.id);
        reject(new RpcError('UNAVAILABLE', 'Could not send request', type));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new RpcError('UNAVAILABLE', 'Channel closed', p.type));
      this.pending.delete(id);
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.options.onInvalid?.('malformed envelope', raw);
      return;
    }
    const envelope = parsed.data;
    if (envelope.kind === 'result') {
      this.settle(envelope);
      return;
    }
    if (envelope.kind === 'event') {
      this.deliver(envelope, raw);
      return;
    }
    const result = await this.dispatch(envelope);
    // The other side may have gone away while the handler ran; there is nobody to answer.
    if (!this.closed) this.reply(envelope, result);
  }

  private deliver(envelope: Envelope, raw: unknown): void {
    if (!isEventType(envelope.type)) {
      this.options.onInvalid?.(`unknown event ${envelope.type}`, raw);
      return;
    }
    const payload = events[envelope.type].payload.safeParse(envelope.payload);
    if (!payload.success) {
      this.options.onInvalid?.(`invalid ${envelope.type} payload`, raw);
      return;
    }
    for (const listener of this.listeners.get(envelope.type) ?? []) {
      try {
        listener(payload.data, envelope);
      } catch (error) {
        this.options.onHandlerError?.(envelope.type, error);
      }
    }
  }

  private async dispatch(envelope: Envelope): Promise<ResultPayload> {
    if (envelope.schemaVersion !== SCHEMA_VERSION) {
      return failure(
        'UNSUPPORTED_SCHEMA_VERSION',
        'Unsupported schema version',
        String(envelope.schemaVersion),
      );
    }
    const type = envelope.type;
    const handler = isRequestType(type) ? this.handlers.get(type) : undefined;
    if (!isRequestType(type) || !handler || requests[type].kind !== envelope.kind) {
      return failure('UNKNOWN_MESSAGE_TYPE', 'Unknown message type', `${envelope.kind} ${type}`);
    }
    const payload = requests[type].request.safeParse(envelope.payload);
    if (!payload.success) {
      return failure('VALIDATION_FAILED', 'Validation failed', z.prettifyError(payload.error));
    }
    try {
      const data = await handler(payload.data, {
        envelope,
        correlationId: envelope.correlationId,
        idempotencyKey: envelope.idempotencyKey,
      });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, error: error.problem };
      this.options.onHandlerError?.(type, error);
      return failure('INTERNAL', 'Internal error', type);
    }
  }

  private reply(request: Envelope, payload: ResultPayload): void {
    this.send({
      id: uuidv7(),
      kind: 'result',
      type: request.type,
      schemaVersion: SCHEMA_VERSION,
      correlationId: request.correlationId,
      causationId: request.id,
      sentAt: new Date().toISOString(),
      payload,
    });
  }

  private send(envelope: Envelope): void {
    try {
      this.endpoint.postMessage(envelope);
    } catch (error) {
      this.options.onHandlerError?.(`send ${envelope.type}`, error);
    }
  }

  private settle(envelope: Envelope): void {
    const pending = envelope.causationId ? this.pending.get(envelope.causationId) : undefined;
    if (!pending || !envelope.causationId) {
      this.options.onInvalid?.(`result without pending request (${envelope.type})`, envelope);
      return;
    }
    this.pending.delete(envelope.causationId);
    clearTimeout(pending.timer);

    const result = resultPayloadSchema.safeParse(envelope.payload);
    if (!result.success) {
      pending.reject(new RpcError('INVALID_MESSAGE', 'Malformed result', pending.type));
      return;
    }
    if (!result.data.ok) {
      const { code, title, detail, fields } = result.data.error;
      pending.reject(new RpcError(code, title, detail, fields));
      return;
    }
    const data = requests[pending.type].response.safeParse(result.data.data);
    if (!data.success) {
      pending.reject(
        new RpcError('INVALID_MESSAGE', 'Response failed validation', z.prettifyError(data.error)),
      );
      return;
    }
    pending.resolve(data.data);
  }
}

function failure(code: ErrorCode, title: string, detail?: string): ResultPayload {
  return { ok: false, error: detail === undefined ? { code, title } : { code, title, detail } };
}
