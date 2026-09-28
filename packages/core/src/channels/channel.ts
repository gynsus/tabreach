/** A message ready to leave TabReach through a channel (the intent side of docs/14). */
export interface OutgoingMessage {
  /** The side-effect ledger key; channels that support it pass it on (e.g. as Message-ID seed). */
  idempotencyKey: string;
  /** Normalized target identity (email address for email, profile URL for LinkedIn). */
  target: string;
  subject: string | null;
  body: string;
  contentHash: string;
}

export type SendResult =
  | { outcome: 'completed'; externalRefs: Record<string, unknown> }
  /** Verified that nothing reached the recipient (rejected before submission). */
  | { outcome: 'not_sent'; errorClass: string }
  /** It may or may not have been delivered. Never retried blindly. */
  | { outcome: 'unknown'; errorClass: string };

export type ReconcileResult = 'completed' | 'not_sent' | 'unknown';

/** Channel adapter, sending side (docs/14-CHANNEL-ADAPTERS.md). */
export interface MessageChannel {
  readonly channel: string;
  /** Minimum time between two sends through this channel account (product pacing, not evasion). */
  readonly minSpacingMs: number;
  send(message: OutgoingMessage, signal: AbortSignal): Promise<SendResult>;
  /** Looks up whether a send with this key reached the outside world (e.g. Sent folder by Message-ID). */
  reconcile(idempotencyKey: string, signal: AbortSignal): Promise<ReconcileResult>;
}
