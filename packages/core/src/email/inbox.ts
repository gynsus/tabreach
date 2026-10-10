import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type ChangedEntity,
  type Conversation,
  type ConversationMessage,
  type ConversationSummary,
  type Logger,
  type StopReason,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import type { CampaignEngine, EnrollmentRow } from '../campaigns/engine.js';
import type { ContactPolicy } from '../campaigns/policy.js';
import { transaction } from '../db/database.js';
import { RetryableError, type JobOutcome, type JobType } from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import { normalizeDomain } from '../prospects/normalize.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SuppressionService } from '../suppressions/suppression-service.js';
import type { AccountService } from './accounts.js';
import { parseInbound, type InboundMail } from './inbound.js';
import { messageIdFor } from './mime.js';
import { InboxAuthError, type InboxSource } from './transport.js';

export const JOB_POLL = 'mailbox.poll';
const POLL_EVERY_MS = 2 * 60_000;
const POLL_AFTER_ERROR_MS = 5 * 60_000;
const FRESH_MS = 5 * 60_000;
const STALE_MS = 30 * 60_000;
const BATCH = 50;

/** Senders that are never a person answering (docs/14), unless they write in a campaign thread. */
const ROLE_SENDER =
  /^(no-?reply|do-?not-?reply|noreply|notifications?|billing|invoices?|jobs|careers|hr|newsletter|marketing|info-noreply)@/i;

type Classification = 'reply' | 'out_of_office' | 'auto' | 'bounce';
type Strength = 'thread' | 'contact_address' | 'domain_only';

export interface SentMessage {
  channel: string;
  accountId: string | null;
  enrollmentId: string;
  contactId: string;
  companyId: string | null;
  idempotencyKey: string;
  subject: string | null;
  body: string;
  externalRefs: Record<string, unknown>;
}

interface ConversationRow {
  id: string;
  channel_account_id: string;
  contact_id: string | null;
  company_id: string | null;
  unread: number;
  last_message_at: string;
}

export type IngestResult =
  | { stored: false; reason: 'duplicate' | 'own_message' | 'unmatched' | 'automatic' }
  | { stored: true; conversationId: string; classification: Classification; match: Strength | null };

export interface InboxDeps {
  db: DatabaseSync;
  now: () => Date;
  audit: AuditLog;
  engine: CampaignEngine;
  policy: ContactPolicy;
  suppressions: SuppressionService;
  accounts: AccountService;
  jobs: JobQueue;
  logger: Logger;
  changed: (entities: ChangedEntity[]) => void;
  /** Told about each stored human reply (e.g. to label it with AI). */
  onReply?: (messageId: string) => void;
}

/**
 * Replies (docs/14 "Common email behaviour", FR-EML-006…008): polls each account's inbox, keeps
 * only messages that belong to prospects, and applies their consequences — a reply stops the
 * contact's sequences (and, if the policy says so, the company's), a hard bounce marks the
 * address and suppresses it. Unrelated mail is never stored.
 */
export class InboxService {
  constructor(private readonly d: InboxDeps) {}

  jobTypes(): JobType<never>[] {
    const poll: JobType<{ accountId: string }> = {
      type: JOB_POLL,
      payload: z.object({ accountId: z.uuid() }),
      sideEffecting: false,
      concurrency: 2,
      maxAttempts: 3,
      handler: ({ accountId }, ctx) => this.pollOnce(accountId, ctx.signal, ctx.correlationId),
    };
    return [poll] as unknown as JobType<never>[];
  }

  schedulePoll(accountId: string, at: Date = this.d.now()): void {
    this.d.jobs.enqueue(JOB_POLL, { accountId }, { runAt: at, dedupeKey: `poll:${accountId}` });
  }

  /** Every active IMAP account keeps one polling job (core start). */
  resync(): void {
    for (const account of this.d.accounts.list()) {
      if (account.status === 'active') this.schedulePoll(account.id);
    }
  }

  // Polling -----------------------------------------------------------------------------------

  private readonly polling = new Map<string, Promise<JobOutcome>>();

  /** One poll per account at a time: a send's freshness check and the polling job share it. */
  pollOnce(accountId: string, signal: AbortSignal, correlationId: string): Promise<JobOutcome> {
    const running = this.polling.get(accountId);
    if (running) return running;
    const promise = this.poll(accountId, signal, correlationId).finally(() => this.polling.delete(accountId));
    this.polling.set(accountId, promise);
    return promise;
  }

  /**
   * Before a send: the inbox must have been read recently, so a reply that already arrived stops
   * the sequence first (audit 3.5: e.g. a reply received while the Mac slept). Reads it now when
   * the last check is older than 5 minutes; refuses when it cannot be read for 30 minutes.
   */
  async ensureFresh(accountId: string, signal: AbortSignal, correlationId: string): Promise<void> {
    if (this.polledWithin(accountId, FRESH_MS)) return;
    await this.pollOnce(accountId, signal, correlationId);
    if (!this.polledWithin(accountId, STALE_MS)) {
      throw new RetryableError('inbox_unavailable', 'The inbox could not be read, so replies may be missed');
    }
  }

  private polledWithin(accountId: string, ms: number): boolean {
    const at = this.cursor(accountId)?.last_polled_at;
    return Boolean(at && this.d.now().getTime() - new Date(at).getTime() <= ms);
  }

  async poll(accountId: string, signal: AbortSignal, correlationId: string): Promise<JobOutcome> {
    try {
      if (this.d.accounts.get(accountId).status !== 'active') return;
    } catch (error) {
      if (error instanceof RpcError && error.problem.code === 'NOT_FOUND') return; // disconnected
      throw error;
    }
    const cursor = this.cursor(accountId);
    let received = 0;
    let more: boolean;
    let source: InboxSource | undefined;
    try {
      source = await this.d.accounts.openInbox(accountId, signal);
      const batch = await source.fetchNew(
        { a: cursor?.uid_validity ?? null, b: cursor?.last_uid ?? null },
        BATCH,
        signal,
      );
      more = batch.more;
      for (const message of batch.messages) {
        let mail: InboundMail | null = null;
        try {
          mail = await parseInbound(await message.load());
        } catch (error) {
          this.d.logger.warn(
            { event: 'inbox.unparseable', accountId, err: error },
            'skipped a message that could not be parsed',
          );
        }
        // One transaction per message: the result and the cursor move together.
        transaction(this.d.db, () => {
          if (mail) {
            const result = this.ingest(accountId, mail, message.providerId, correlationId);
            if (result.stored) received++;
          }
          this.saveCursor(accountId, { uidValidity: message.cursor.a, lastUid: message.cursor.b });
        });
      }
      this.saveCursor(accountId, { uidValidity: batch.cursor.a, lastUid: batch.cursor.b, polled: true });
      if (batch.warning) {
        // Replies received meanwhile may have been missed: say so where the user looks back.
        this.d.logger.warn(
          { event: 'inbox.history_expired', accountId },
          'replies received while offline may have been missed',
        );
        this.d.audit.record({
          actorType: 'channel_adapter',
          actionType: 'account.inbox_gap',
          objectType: 'account',
          objectId: accountId,
          status: 'failed',
          correlationId,
        });
      }
    } catch (error) {
      const auth = error instanceof InboxAuthError;
      if (auth) this.d.accounts.markAuthRequired(accountId);
      this.saveCursor(accountId, { error: auth ? 'authFailed' : 'connectionFailed' });
      this.d.logger.warn(
        { event: 'inbox.poll_failed', accountId, auth, err: auth ? undefined : error },
        'could not read the inbox',
      );
      this.d.changed(['account']);
      return auth ? undefined : { continueAt: new Date(this.d.now().getTime() + POLL_AFTER_ERROR_MS) };
    } finally {
      await source?.close();
    }
    if (received > 0) this.d.changed(['conversation', 'enrollment', 'campaign', 'activity']);
    else this.d.changed(['account']);
    return { continueAt: new Date(this.d.now().getTime() + (more ? 1_000 : POLL_EVERY_MS)) };
  }

  // Outgoing --------------------------------------------------------------------------------

  /** Records a sent campaign email so replies can be matched to it by thread. */
  recordSent(sent: SentMessage): void {
    if (sent.channel !== 'email' || !sent.accountId) return;
    const address = this.d.accounts.addressOf(sent.accountId);
    if (!address) return;
    const rfcId =
      typeof sent.externalRefs.messageId === 'string'
        ? sent.externalRefs.messageId
        : messageIdFor(sent.idempotencyKey, address);
    const conversation = this.conversationFor(
      sent.accountId,
      sent.contactId,
      sent.companyId,
      sent.enrollmentId,
    );
    const exists = this.d.db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id = ? AND rfc_message_id = ? AND direction = 'outbound'`,
      )
      .get(conversation.id, rfcId);
    if (exists) return;
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, direction, rfc_message_id, from_address, subject, body, occurred_at, created_at)
         VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv7(), conversation.id, rfcId, address, sent.subject, sent.body, ts, ts);
    this.touch(conversation.id, ts, false);
    this.d.changed(['conversation']);
  }

  // Incoming --------------------------------------------------------------------------------

  ingest(accountId: string, mail: InboundMail, providerId: string, correlationId: string): IngestResult {
    return transaction(this.d.db, () => {
      const seen = this.d.db
        .prepare(
          `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.channel_account_id = ? AND (m.provider_message_id = ? OR (m.rfc_message_id IS NOT NULL AND m.rfc_message_id = ?))`,
        )
        .get(accountId, providerId, mail.rfcMessageId ?? '');
      if (seen) return { stored: false, reason: 'duplicate' };
      const own = this.d.accounts.addressOf(accountId);
      if (mail.from && mail.from === own && !mail.bounce) return { stored: false, reason: 'own_message' };

      if (mail.bounce) return this.ingestBounce(accountId, mail, providerId, correlationId);

      const thread = this.threadMatch(accountId, mail.references);
      let contactId = thread?.contact_id ?? null;
      // The company as it is now: the contact may have moved since the conversation began.
      let companyId = contactId ? this.companyOf(contactId) : (thread?.company_id ?? null);
      let strength: Strength | null = thread ? 'thread' : null;
      if (!strength && mail.from) {
        // Only people and companies TabReach wrote to (ADR 024, audit 3.5): mail from a contact or
        // a company domain that was never written to is not a reply and is not stored.
        const contact = this.d.db
          .prepare(`SELECT id, company_id FROM contacts WHERE email_normalized = ? AND status = 'active'`)
          .get(mail.from) as { id: string; company_id: string | null } | undefined;
        if (contact && this.wroteTo('contact', contact.id)) {
          contactId = contact.id;
          companyId = contact.company_id;
          strength = 'contact_address';
        } else if (!contact && !ROLE_SENDER.test(mail.from)) {
          const company = this.companyByDomain(mail.from);
          if (company && this.wroteTo('company', company)) {
            companyId = company;
            strength = 'domain_only';
          }
        }
      }
      if (!strength) return { stored: false, reason: 'unmatched' };
      let classification: Classification;
      if (mail.outOfOffice) {
        if (strength === 'domain_only') return { stored: false, reason: 'automatic' };
        classification = 'out_of_office';
      } else if (mail.autoGenerated) {
        // Notifications are never replies; inside a campaign thread they are kept for context.
        if (strength !== 'thread') return { stored: false, reason: 'automatic' };
        classification = 'auto';
      } else if (mail.bulk && strength !== 'thread') {
        // List headers outside our thread: a newsletter. Inside it: a person answering from a
        // group mailbox (Google Groups, M365), which adds the same headers.
        return { stored: false, reason: 'automatic' };
      } else {
        classification = 'reply';
      }
      const conversation =
        strength === 'domain_only'
          ? this.conversationFor(accountId, null, companyId, null)
          : this.conversationFor(accountId, contactId as string, companyId, null);
      const messageId = this.insertInbound(conversation.id, mail, providerId, classification, strength);
      this.d.audit.record({
        actorType: 'channel_adapter',
        actionType: 'message.received',
        objectType: 'conversation',
        objectId: conversation.id,
        payload: { messageId, classification, match: strength },
        correlationId,
      });
      if (classification === 'reply') this.d.onReply?.(messageId);
      if (classification === 'reply' && strength !== 'domain_only' && contactId) {
        this.stopForReply(contactId, companyId, correlationId);
      }
      return { stored: true, conversationId: conversation.id, classification, match: strength };
    });
  }

  private ingestBounce(
    accountId: string,
    mail: InboundMail,
    providerId: string,
    correlationId: string,
  ): IngestResult {
    const bounce = mail.bounce as NonNullable<InboundMail['bounce']>;
    const original = bounce.originalMessageId
      ? this.threadMatch(accountId, [bounce.originalMessageId])
      : undefined;
    let contactId = original?.contact_id ?? null;
    if (!contactId) {
      // Without our Message-ID in the report, only an address we actually wrote to counts: anyone
      // can send a mail that looks like a bounce (audit 3.5).
      for (const address of bounce.recipients) {
        const c = this.d.db.prepare('SELECT id FROM contacts WHERE email_normalized = ?').get(address) as
          { id: string } | undefined;
        if (c && this.wroteTo('contact', c.id)) {
          contactId = c.id;
          break;
        }
      }
    }
    if (!contactId) return { stored: false, reason: 'unmatched' };
    const contact = this.d.db
      .prepare('SELECT company_id, email_normalized FROM contacts WHERE id = ?')
      .get(contactId) as {
      company_id: string | null;
      email_normalized: string | null;
    };
    const conversation = this.conversationFor(accountId, contactId, contact.company_id, null);
    this.insertInbound(conversation.id, mail, providerId, 'bounce', original ? 'thread' : 'contact_address');
    if (
      bounce.permanent &&
      contact.email_normalized &&
      (bounce.recipients.length === 0 || bounce.recipients.includes(contact.email_normalized))
    ) {
      this.d.db
        .prepare(`UPDATE contacts SET email_status = 'bounced', updated_at = ? WHERE id = ?`)
        .run(this.d.now().toISOString(), contactId);
      this.d.suppressions.addAutomatic('email', contact.email_normalized, 'bounce', { correlationId });
      this.d.audit.record({
        actorType: 'channel_adapter',
        actionType: 'contact.bounced',
        objectType: 'contact',
        objectId: contactId,
        correlationId,
      });
      for (const e of this.liveEnrollments('e.contact_id = ?', contactId)) {
        this.d.engine.stopEnrollment(e, 'bounced', correlationId, 'system');
      }
    }
    return {
      stored: true,
      conversationId: conversation.id,
      classification: 'bounce',
      match: original ? 'thread' : 'contact_address',
    };
  }

  /** A reply stops the contact's sequences, and the company's when the policy says so (strong matches only). */
  private stopForReply(contactId: string, companyId: string | null, correlationId: string): void {
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare('UPDATE campaign_enrollments SET last_reply_at = ? WHERE contact_id = ?')
      .run(ts, contactId);
    for (const e of this.liveEnrollments('e.contact_id = ?', contactId))
      this.stop(e, 'replied', correlationId);
    if (companyId && this.d.policy.current().companyStopOnReply)
      this.stopCompany(companyId, contactId, correlationId);
  }

  private stopCompany(companyId: string, exceptContactId: string | null, correlationId: string): void {
    const others = this.liveEnrollments(
      'e.contact_id IN (SELECT id FROM contacts WHERE company_id = ?) AND e.contact_id IS NOT ?',
      companyId,
      exceptContactId,
    );
    for (const e of others) this.stop(e, 'company_replied', correlationId);
  }

  private stop(e: EnrollmentRow, reason: StopReason, correlationId: string): void {
    this.d.engine.stopEnrollment(e, reason, correlationId, 'system');
  }

  private liveEnrollments(where: string, ...params: (string | null)[]): EnrollmentRow[] {
    return this.d.db
      .prepare(`SELECT e.* FROM campaign_enrollments e WHERE e.status IN ('active', 'paused') AND ${where}`)
      .all(...params) as unknown as EnrollmentRow[];
  }

  // Reads and user actions ------------------------------------------------------------------

  list(
    filter: 'all' | 'unread' | 'review',
    page: { limit: number; offset: number },
  ): { items: ConversationSummary[]; total: number; unread: number } {
    const where =
      filter === 'unread'
        ? 'WHERE c.unread = 1'
        : filter === 'review'
          ? `WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.review_status = 'pending')`
          : `WHERE EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound')`;
    const rows = this.d.db
      .prepare(
        `SELECT c.* FROM conversations c ${where} ORDER BY c.last_message_at DESC, c.id DESC LIMIT ? OFFSET ?`,
      )
      .all(page.limit, page.offset) as unknown as ConversationRow[];
    const total = (
      this.d.db.prepare(`SELECT COUNT(*) AS n FROM conversations c ${where}`).get() as { n: number }
    ).n;
    const unread = (
      this.d.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE unread = 1').get() as { n: number }
    ).n;
    return { items: rows.map((r) => this.summary(r)), total, unread };
  }

  get(id: string): Omit<Conversation, 'replyTarget' | 'replies'> {
    const row = this.row(id);
    const messages = this.d.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY occurred_at, created_at')
      .all(id) as unknown as MessageRow[];
    return { ...this.summary(row), messages: messages.map(toMessageDto) };
  }

  markRead(id: string): void {
    this.row(id);
    this.d.db
      .prepare('UPDATE conversations SET unread = 0, updated_at = ? WHERE id = ?')
      .run(this.d.now().toISOString(), id);
  }

  /** The user decides about a possible reply that matched only the company domain. */
  review(messageId: string, decision: 'confirm' | 'dismiss', ctx: CommandContext): void {
    transaction(this.d.db, () => {
      const m = this.d.db
        .prepare(
          `SELECT m.id, m.review_status, c.company_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?`,
        )
        .get(messageId) as { id: string; review_status: string; company_id: string | null } | undefined;
      if (!m) throw new RpcError('NOT_FOUND', 'Message not found', 'message.notFound');
      if (m.review_status !== 'pending')
        throw new RpcError('CONFLICT', 'Already reviewed', 'message.reviewed');
      this.d.db
        .prepare('UPDATE messages SET review_status = ? WHERE id = ?')
        .run(decision === 'confirm' ? 'confirmed' : 'dismissed', messageId);
      this.d.audit.record({
        actorType: 'user',
        actionType: 'message.reviewed',
        objectType: 'conversation',
        payload: { messageId, decision },
        correlationId: ctx.correlationId,
      });
      if (decision === 'confirm' && m.company_id && this.d.policy.current().companyStopOnReply) {
        this.stopCompany(m.company_id, null, ctx.correlationId);
      }
    });
  }

  // Storage helpers -------------------------------------------------------------------------

  private insertInbound(
    conversationId: string,
    mail: InboundMail,
    providerId: string,
    classification: Classification,
    strength: Strength,
  ): string {
    const id = uuidv7();
    const ts = this.d.now().toISOString();
    const occurred = mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date.toISOString() : ts;
    this.d.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, direction, rfc_message_id, provider_message_id, in_reply_to, from_address,
                               subject, body, classification, match_strength, review_status, occurred_at, created_at)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        conversationId,
        mail.rfcMessageId,
        providerId,
        mail.inReplyTo,
        mail.from,
        mail.subject,
        mail.text,
        classification,
        strength,
        strength === 'domain_only' ? 'pending' : 'none',
        occurred,
        ts,
      );
    this.touch(conversationId, ts, true);
    return id;
  }

  private touch(conversationId: string, ts: string, unread: boolean): void {
    this.d.db
      .prepare(
        `UPDATE conversations SET last_message_at = ?, updated_at = ?, unread = CASE WHEN ? THEN 1 ELSE unread END WHERE id = ?`,
      )
      .run(ts, ts, unread ? 1 : 0, conversationId);
  }

  private conversationFor(
    accountId: string,
    contactId: string | null,
    companyId: string | null,
    enrollmentId: string | null,
  ): ConversationRow {
    const existing = (
      contactId
        ? this.d.db
            .prepare('SELECT * FROM conversations WHERE channel_account_id = ? AND contact_id = ?')
            .get(accountId, contactId)
        : this.d.db
            .prepare(
              'SELECT * FROM conversations WHERE channel_account_id = ? AND contact_id IS NULL AND company_id = ?',
            )
            .get(accountId, companyId)
    ) as ConversationRow | undefined;
    if (existing) {
      if (enrollmentId) {
        this.d.db
          .prepare('UPDATE conversations SET campaign_enrollment_id = ? WHERE id = ?')
          .run(enrollmentId, existing.id);
      }
      return existing;
    }
    const id = uuidv7();
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO conversations (id, channel, channel_account_id, contact_id, company_id, campaign_enrollment_id, last_message_at,
                                    created_at, updated_at)
         VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, accountId, contactId, companyId, enrollmentId, ts, ts, ts);
    return this.d.db
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as unknown as ConversationRow;
  }

  /** Whether TabReach ever sent a message to this contact, or to anyone at this company. */
  private wroteTo(kind: 'contact' | 'company', id: string): boolean {
    const sql =
      kind === 'contact'
        ? `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.direction = 'outbound' AND c.contact_id = ? LIMIT 1`
        : `SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE m.direction = 'outbound' AND (c.company_id = ? OR c.contact_id IN (SELECT id FROM contacts WHERE company_id = ?))
           LIMIT 1`;
    return this.d.db.prepare(sql).get(...(kind === 'contact' ? [id] : [id, id])) !== undefined;
  }

  private companyOf(contactId: string): string | null {
    return (
      (
        this.d.db.prepare('SELECT company_id FROM contacts WHERE id = ?').get(contactId) as
          { company_id: string | null } | undefined
      )?.company_id ?? null
    );
  }

  /** The conversation of one of our messages this message refers to (In-Reply-To / References). */
  private threadMatch(accountId: string, references: readonly string[]): ConversationRow | undefined {
    if (references.length === 0) return undefined;
    return this.d.db
      .prepare(
        `SELECT c.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.channel_account_id = ? AND m.direction = 'outbound' AND m.rfc_message_id IN (${references.map(() => '?').join(', ')})
         ORDER BY m.occurred_at DESC LIMIT 1`,
      )
      .get(accountId, ...references) as ConversationRow | undefined;
  }

  private companyByDomain(address: string): string | null {
    const domain = normalizeDomain(address.split('@')[1] ?? null);
    if (!domain) return null;
    const labels = domain.split('.');
    const candidates = labels.slice(0, -1).map((_, i) => labels.slice(i).join('.'));
    const row = this.d.db
      .prepare(
        `SELECT id FROM companies WHERE domain_normalized IN (${candidates.map(() => '?').join(', ')}) AND status = 'active' LIMIT 1`,
      )
      .get(...candidates) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private cursor(accountId: string) {
    return this.d.db.prepare('SELECT * FROM mailbox_cursors WHERE channel_account_id = ?').get(accountId) as
      { uid_validity: number | null; last_uid: number | null; last_polled_at: string | null } | undefined;
  }

  private saveCursor(
    accountId: string,
    v: { uidValidity?: number; lastUid?: number; polled?: boolean; error?: string },
  ): void {
    const ts = this.d.now().toISOString();
    this.d.db
      .prepare(
        `INSERT INTO mailbox_cursors (channel_account_id, folder, uid_validity, last_uid, last_polled_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (channel_account_id) DO UPDATE SET
           uid_validity = COALESCE(excluded.uid_validity, uid_validity),
           last_uid = COALESCE(excluded.last_uid, last_uid),
           last_polled_at = COALESCE(excluded.last_polled_at, last_polled_at),
           last_error = excluded.last_error`,
      )
      .run(
        accountId,
        'INBOX',
        v.uidValidity ?? null,
        v.lastUid ?? null,
        v.polled ? ts : null,
        v.error ?? null,
      );
  }

  private row(id: string): ConversationRow {
    const row = this.d.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      ConversationRow | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'Conversation not found', 'conversation.notFound');
    return row;
  }

  private summary(r: ConversationRow): ConversationSummary {
    const last = this.d.db
      .prepare(
        `SELECT body, classification, ai_label FROM messages WHERE conversation_id = ? AND direction = 'inbound' ORDER BY occurred_at DESC LIMIT 1`,
      )
      .get(r.id) as
      | {
          body: string | null;
          classification: Classification | null;
          ai_label: ConversationSummary['lastLabel'];
        }
      | undefined;
    const review = this.d.db
      .prepare(`SELECT 1 FROM messages WHERE conversation_id = ? AND review_status = 'pending'`)
      .get(r.id);
    const contact = r.contact_id
      ? (this.d.db
          .prepare('SELECT first_name, last_name, full_name, email FROM contacts WHERE id = ?')
          .get(r.contact_id) as {
          first_name: string | null;
          last_name: string | null;
          full_name: string | null;
          email: string | null;
        })
      : undefined;
    const company = r.company_id
      ? (this.d.db.prepare('SELECT name FROM companies WHERE id = ?').get(r.company_id) as
          { name: string } | undefined)
      : undefined;
    const title = contact
      ? (contact.full_name ??
        ([contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email || '—'))
      : (company?.name ?? '—');
    return {
      id: r.id,
      accountAddress: this.d.accounts.addressOf(r.channel_account_id) ?? '',
      contactAddress: contact?.email ?? null,
      contactId: r.contact_id,
      companyId: r.company_id,
      title,
      lastMessageAt: r.last_message_at,
      lastSnippet: (last?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      lastClassification: last?.classification ?? null,
      lastLabel: last?.ai_label ?? null,
      unread: r.unread === 1,
      needsReview: review !== undefined,
    };
  }
}

interface MessageRow {
  id: string;
  direction: 'inbound' | 'outbound';
  from_address: string | null;
  subject: string | null;
  body: string | null;
  classification: Classification | null;
  ai_label: ConversationMessage['label'];
  match_strength: Strength | null;
  review_status: ConversationMessage['reviewStatus'];
  occurred_at: string;
}

function toMessageDto(m: MessageRow): ConversationMessage {
  return {
    id: m.id,
    direction: m.direction,
    from: m.from_address,
    subject: m.subject,
    body: m.body,
    classification: m.classification,
    label: m.ai_label,
    matchStrength: m.match_strength,
    reviewStatus: m.review_status,
    occurredAt: m.occurred_at,
  };
}
