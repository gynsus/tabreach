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
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const problemSchema = z.object({
  code: errorCodeSchema,
  title: z.string(),
  detail: z.string().optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const resultPayloadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: problemSchema }),
]);
export type ResultPayload = z.infer<typeof resultPayloadSchema>;
