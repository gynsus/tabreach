import type { Logger } from '@tabreach/protocol';
import type { MessageChannel, OutgoingMessage, ReconcileResult, SendResult } from '../channels/channel.js';
import { composeMessage, messageIdFor } from './mime.js';
import { classifySmtpError } from './smtp-errors.js';
import type { MailClients, MailSettings } from './transport.js';

/**
 * How long after an attempt a missing Sent copy still means "not indexed yet" rather than "not
 * sent". Only used for servers that store sent mail themselves (ADR 016: delayed retries).
 */
export const SENT_INDEX_GRACE_MS = 10 * 60_000;
const RECHECK_MS = 2 * 60_000;

export interface EmailAccountConfig {
  id: string;
  address: string;
  fromName: string | null;
  minSpacingMs: number;
  dailyLimit: number;
  /** The server does not keep sent mail: TabReach appends a copy to Sent itself. */
  appendToSent: boolean;
}

/**
 * Email over SMTP, with IMAP for the Sent folder (docs/14). Every message carries a Message-ID
 * derived from its ledger key; reconciliation looks for it in Sent.
 */
export class EmailChannel implements MessageChannel {
  readonly channel = 'email';
  readonly accountId: string;
  readonly minSpacingMs: number;
  readonly dailyLimit: number;

  constructor(
    private readonly account: EmailAccountConfig,
    /** Resolves the account's credentials only when needed (the password is decrypted by main). */
    private readonly settings: () => Promise<MailSettings>,
    private readonly clients: MailClients,
    private readonly now: () => Date,
    private readonly logger: Logger,
    /** The server refused the credentials: the account needs the user's attention. */
    private readonly onAuthFailed: () => void = () => {},
  ) {
    this.accountId = account.id;
    this.minSpacingMs = account.minSpacingMs;
    this.dailyLimit = account.dailyLimit;
  }

  async send(message: OutgoingMessage, signal: AbortSignal): Promise<SendResult> {
    let settings: MailSettings;
    try {
      settings = await this.settings();
    } catch (error) {
      this.logger.warn(
        { event: 'email.credentials_unavailable', accountId: this.accountId, err: error },
        'no credentials',
      );
      return { outcome: 'not_sent', errorClass: 'credentials_unavailable' };
    }
    const messageId = messageIdFor(message.idempotencyKey, this.account.address);
    const raw = await composeMessage({
      from: { address: this.account.address, name: this.account.fromName },
      to: { address: message.target, name: message.recipientName ?? null },
      subject: message.subject,
      body: message.body,
      messageId,
      date: this.now(),
    });
    const smtp = this.clients.smtp(settings);
    let response: string;
    try {
      ({ response } = await smtp.send(raw, { from: this.account.address, to: message.target }, signal));
    } catch (error) {
      const result = classifySmtpError(error);
      if (result.errorClass === 'auth_failed') this.onAuthFailed();
      this.logger.warn(
        {
          event: 'email.send_failed',
          accountId: this.accountId,
          outcome: result.outcome,
          errorClass: result.errorClass,
        },
        'SMTP send failed',
      );
      return result;
    } finally {
      smtp.close();
    }
    const refs: Record<string, unknown> = { messageId, smtpResponse: response.slice(0, 200) };
    if (this.account.appendToSent) {
      // Sent, but the copy for the Sent folder is a separate step. Failing it does not make the
      // message unsent; it only means reconciliation could not find it later.
      try {
        await this.withMailbox(settings, signal, async (box) => {
          const folder = await box.sentFolder(signal);
          if (folder) await box.append(folder, raw, signal);
          refs.sentCopy = folder ? 'appended' : 'no_sent_folder';
        });
      } catch (error) {
        refs.sentCopy = 'failed';
        this.logger.warn(
          { event: 'email.sent_copy_failed', accountId: this.accountId, err: error },
          'could not save a copy to Sent',
        );
      }
    }
    return { outcome: 'completed', externalRefs: refs };
  }

  async reconcile(
    idempotencyKey: string,
    signal: AbortSignal,
    attemptStartedAt: Date,
  ): Promise<ReconcileResult> {
    const messageId = messageIdFor(idempotencyKey, this.account.address);
    let found: boolean | 'no_sent_folder';
    try {
      const settings = await this.settings();
      found = await this.withMailbox(settings, signal, async (box) => {
        const folder = await box.sentFolder(signal);
        return folder ? box.hasMessage(folder, messageId, signal) : 'no_sent_folder';
      });
    } catch (error) {
      // The mailbox could not be checked: nothing is decided, try again later.
      this.logger.warn(
        { event: 'email.reconcile_failed', accountId: this.accountId, err: error },
        'could not search Sent',
      );
      return { status: 'pending', retryAt: new Date(this.now().getTime() + RECHECK_MS) };
    }
    if (found === true) return { status: 'completed', externalRefs: { messageId, reconciledIn: 'sent' } };
    // Without a Sent folder, or without a server-side Sent copy, absence proves nothing: a person decides.
    if (found === 'no_sent_folder' || this.account.appendToSent) return { status: 'unknown' };
    const settledAt = attemptStartedAt.getTime() + SENT_INDEX_GRACE_MS;
    if (this.now().getTime() < settledAt) {
      return { status: 'pending', retryAt: new Date(Math.min(settledAt, this.now().getTime() + RECHECK_MS)) };
    }
    return { status: 'not_sent' };
  }

  private async withMailbox<T>(
    settings: MailSettings,
    signal: AbortSignal,
    fn: (box: Awaited<ReturnType<MailClients['mailbox']>>) => Promise<T>,
  ): Promise<T> {
    const box = await this.clients.mailbox(settings, signal);
    try {
      return await fn(box);
    } finally {
      await box.close();
    }
  }
}
