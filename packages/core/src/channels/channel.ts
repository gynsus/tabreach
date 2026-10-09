/** A message ready to leave TabReach through a channel (the intent side of docs/14). */
export interface OutgoingMessage {
  /** The side-effect ledger key; channels that support it derive a stable id from it (e.g. Message-ID). */
  idempotencyKey: string;
  /** Normalized target identity (email address for email, profile URL for LinkedIn). */
  target: string;
  /** Display name of the recipient, where the channel shows one ("Ann Lee" <ann@acme.com>). */
  recipientName?: string | null;
  subject: string | null;
  body: string;
  contentHash: string;
}

export type SendResult =
  | { outcome: 'completed'; externalRefs: Record<string, unknown> }
  /**
   * Verified that nothing reached the recipient (rejected before submission). `permanent`: trying
   * again cannot help (the server refuses the recipient, say).
   */
  | { outcome: 'not_sent'; errorClass: string; permanent?: boolean }
  /** It may or may not have been delivered. Never retried blindly. */
  | { outcome: 'unknown'; errorClass: string };

/** What reconciliation found out about an earlier attempt. */
export type ReconcileResult =
  | { status: 'completed'; externalRefs?: Record<string, unknown> }
  | { status: 'not_sent' }
  /** Cannot be decided automatically; a person has to confirm. */
  | { status: 'unknown' }
  /** Too early to tell (the Sent search index lags, say): ask again at `retryAt`. */
  | { status: 'pending'; retryAt: Date };

/** Browser channels (docs/07 "Checkpoint rule"): the moment the irreversible part begins. */
export interface SendHooks {
  /** Records "executing" in the ledger; throws when the action must not happen after all. */
  beforeCommit(): void;
}

/** Channel adapter, sending side (docs/14-CHANNEL-ADAPTERS.md). */
export interface MessageChannel {
  /**
   * The channel reports its own commit point through `hooks.beforeCommit` (browser channels): the
   * ledger stays `reserved` until then, so a failure before it is a verified "not sent".
   */
  readonly commitsAtCheckpoint?: boolean;
  /**
   * Nothing can look an uncertain attempt up afterwards (a browser action): only the person can
   * say whether it was sent, so an `unknown` waits for them at once instead of being retried.
   */
  readonly confirmedByPerson?: boolean;
  readonly channel: string;
  /** The channel account that sends; pacing is per account. Null for the test channel. */
  readonly accountId: string | null;
  /** Minimum time between two sends through this channel account (product pacing, not evasion). */
  readonly minSpacingMs: number;
  /** Most sends in any 24 hours through this channel account; null = no limit. */
  readonly dailyLimit: number | null;
  send(message: OutgoingMessage, signal: AbortSignal, hooks?: SendHooks): Promise<SendResult>;
  /**
   * Why the channel may not act right now (a switched-off adapter, FR-LIN-001), or null. Checked
   * at the final pre-send check and again at the checkpoint: off means nothing is sent.
   */
  unavailable?(): string | null;
  /** Per-action-class limits of the channel account (FR-LIN-005), besides spacing and the daily limit. */
  checkLimits?(actionType: string, idempotencyKey: string): { until: Date; rule: string } | null;
  /**
   * Finds out whether an attempt with this key reached the outside world (the Sent folder by
   * Message-ID, say). `attemptStartedAt` is when the attempt was marked executing.
   */
  reconcile(idempotencyKey: string, signal: AbortSignal, attemptStartedAt: Date): Promise<ReconcileResult>;
}

/** Finds the channel for a step: its channel name plus the account the campaign sends from. */
export type ChannelResolver = (
  channel: string,
  config: { emailAccountId?: string | null | undefined },
) => MessageChannel | undefined;
