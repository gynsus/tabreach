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
}

type Handler<T extends RequestType> = (
  payload: z.output<(typeof requests)[T]['request']>,
  ctx: HandlerContext,
) => Promise<ResponseOf<T>> | ResponseOf<T>;

export interface RpcPeerOptions {
  /** Default request timeout. */
  timeoutMs?: number;
  /** Called for messages that cannot be answered (malformed envelopes, stray results). */
  onInvalid?: (reason: string, raw: unknown) => void;
  /** Called when a handler throws something other than RpcError. */
  onHandlerError?: (type: string, error: unknown) => void;
}

interface Pending {
  type: RequestType;
  resolve: (value: unknown) => void;
  reject: (error: RpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcPeer {
  private readonly handlers = new Map<RequestType, Handler<RequestType>>();
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
      void this.receive(raw);
    });
  }

  handle<T extends RequestType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as Handler<RequestType>);
    return this;
  }

  request<T extends RequestType>(
    type: T,
    payload: RequestOf<T>,
    opts: { correlationId?: string; timeoutMs?: number } = {},
  ): Promise<ResponseOf<T>> {
    if (this.closed) {
      return Promise.reject(new RpcError('UNAVAILABLE', 'Channel closed'));
    }
    const envelope: Envelope = {
      id: uuidv7(),
      kind: requests[type].kind,
      type,
      schemaVersion: SCHEMA_VERSION,
      correlationId: opts.correlationId ?? uuidv7(),
      sentAt: new Date().toISOString(),
      payload,
    };
    return new Promise<ResponseOf<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.id);
        reject(new RpcError('TIMEOUT', 'Request timed out', type));
      }, opts.timeoutMs ?? this.timeoutMs);
      this.pending.set(envelope.id, {
        type,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.endpoint.postMessage(envelope);
    });
  }

  close(): void {
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
      this.options.onInvalid?.(`unexpected event ${envelope.type}`, raw);
      return;
    }
    this.reply(envelope, await this.dispatch(envelope));
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
      const data = await handler(payload.data, { envelope, correlationId: envelope.correlationId });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, error: error.problem };
      this.options.onHandlerError?.(type, error);
      return failure('INTERNAL', 'Internal error', type);
    }
  }

  private reply(request: Envelope, payload: ResultPayload): void {
    const envelope: Envelope = {
      id: uuidv7(),
      kind: 'result',
      type: request.type,
      schemaVersion: SCHEMA_VERSION,
      correlationId: request.correlationId,
      causationId: request.id,
      sentAt: new Date().toISOString(),
      payload,
    };
    this.endpoint.postMessage(envelope);
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
