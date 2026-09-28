import type { Logger } from '@tabreach/protocol';
import type { MessageChannel, OutgoingMessage, ReconcileResult, SendResult } from '../channels/channel.js';
import { RECONCILE_GIVE_UP_MS, SENT_INDEX_GRACE_MS, type EmailAccountConfig } from './email-channel.js';
import type { GmailApi } from './gmail.js';
import { composeMessage, messageIdFor } from './mime.js';

const RECHECK_MS = 2 * 60_000;

/**
 * Email through the Gmail API (docs/14). Same Message-ID rule as SMTP (ADR 023); messages sent
 * through the API always land in Sent, so a search by Message-ID settles an interrupted send once
 * the search index caught up.
 */
export class GmailChannel implements MessageChannel {
  readonly channel = 'email';
  readonly accountId: string;
  readonly minSpacingMs: number;
  readonly dailyLimit: number;

  constructor(
    private readonly account: Omit<EmailAccountConfig, 'appendToSent'>,
    private readonly api: () => Promise<GmailApi>,
    private readonly now: () => Date,
    private readonly logger: Logger,
    private readonly onAuthFailed: () => void,
  ) {
    this.accountId = account.id;
    this.minSpacingMs = account.minSpacingMs;
    this.dailyLimit = account.dailyLimit;
  }

  async send(message: OutgoingMessage, signal: AbortSignal): Promise<SendResult> {
    const messageId = messageIdFor(message.idempotencyKey, this.account.address);
    const raw = await composeMessage({
      from: { address: this.account.address, name: this.account.fromName },
      to: { address: message.target, name: message.recipientName ?? null },
      subject: message.subject,
      body: message.body,
      messageId,
      date: this.now(),
    });
    const result = await (await this.api()).send(raw, signal);
    if (result.outcome === 'completed')
      return { ...result, externalRefs: { ...result.externalRefs, messageId } };
    if (result.errorClass === 'auth_failed') this.onAuthFailed();
    this.logger.warn(
      { event: 'gmail.send_failed', outcome: result.outcome, errorClass: result.errorClass },
      'Gmail send failed',
    );
    return result;
  }

  async reconcile(
    idempotencyKey: string,
    signal: AbortSignal,
    attemptStartedAt: Date,
  ): Promise<ReconcileResult> {
    const messageId = messageIdFor(idempotencyKey, this.account.address);
    let found: boolean;
    try {
      found = await (await this.api()).hasRfcMessage(messageId, signal);
    } catch (error) {
      this.logger.warn({ event: 'gmail.reconcile_failed', err: error }, 'could not search Gmail');
      if (this.now().getTime() - attemptStartedAt.getTime() > RECONCILE_GIVE_UP_MS)
        return { status: 'unknown' };
      return { status: 'pending', retryAt: new Date(this.now().getTime() + RECHECK_MS) };
    }
    if (found) return { status: 'completed', externalRefs: { messageId, reconciledIn: 'gmail_search' } };
    const settledAt = attemptStartedAt.getTime() + SENT_INDEX_GRACE_MS;
    if (this.now().getTime() < settledAt) {
      return { status: 'pending', retryAt: new Date(Math.min(settledAt, this.now().getTime() + RECHECK_MS)) };
    }
    // Not verified that Gmail keeps a Message-ID given to messages.send: absence is not proof of
    // not sent, so a person decides (audit 3.5, ADR 023) until that is confirmed on a live account.
    return { status: 'unknown' };
  }
}
