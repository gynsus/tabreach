import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const messageKindSchema = z.enum(['command', 'query', 'result', 'event']);
export type MessageKind = z.infer<typeof messageKindSchema>;

/** Common envelope for every inter-process message (docs/03-SYSTEM-ARCHITECTURE.md). */
export const envelopeSchema = z.object({
  id: z.uuid(),
  kind: messageKindSchema,
  type: z.string().min(1).max(100),
  schemaVersion: z.number().int().positive(),
  correlationId: z.uuid(),
  causationId: z.uuid().optional(),
  /**
   * Caller-chosen key for commands that create things: a retry with the same key returns the first
   * result instead of executing again (ADR 020). Generated once per user intent, reused on retry.
   */
  idempotencyKey: z.uuid().optional(),
  sentAt: z.iso.datetime(),
  payload: z.unknown(),
});
export type Envelope = z.infer<typeof envelopeSchema>;

/** Stable machine codes (docs/25-DEVELOPMENT-CONVENTIONS.md) plus protocol-level codes. */
export const errorCodeSchema = z.enum([
  'VALIDATION_FAILED',
  'INVALID_MESSAGE',
  'UNKNOWN_MESSAGE_TYPE',
  'UNSUPPORTED_SCHEMA_VERSION',
  'TIMEOUT',
  'UNAVAILABLE',
  'INTERNAL',
  'BROWSER_CHROME_NOT_FOUND',
  /** Chrome did not start with a profile (docs/08); the detail says why. */
  'BROWSER_LAUNCH_FAILED',
  'NOT_FOUND',
  /** The action does not fit the current state (e.g. launching an archived campaign). */
  'CONFLICT',
  /** The draft or target changed after the user looked at it (ADR 021 §4). */
  'APPROVAL_STALE',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const problemSchema = z.object({
  code: errorCodeSchema,
  title: z.string(),
  detail: z.string().optional(),
  /** Per-field message keys (e.g. `email.invalid`) that the UI translates; values are keys, not text. */
  fields: z.record(z.string(), z.string()).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const resultPayloadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: problemSchema }),
]);
export type ResultPayload = z.infer<typeof resultPayloadSchema>;
