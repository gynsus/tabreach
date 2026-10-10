import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  RpcError,
  uuidv7,
  type ChangedEntity,
  type Conversation,
  type Logger,
  type ManualReply,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import type { ContactPolicy } from '../campaigns/policy.js';
import type { MessageChannel } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import { RetryableError, type JobContext, type JobOutcome, type JobType } from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import { executeSideEffect } from '../ledger/execute.js';
import type { SideEffectLedger, SideEffectRow } from '../ledger/side-effects.js';
import { normalizeEmail } from '../prospects/normalize.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import { messageIdFor } from './mime.js';

export const JOB_REPLY = 'reply.send';
/** The ledger action type of a reply from the inbox (distinguishes it from campaign sends). */
export const REPLY_ACTION = 'email.reply';
const PAUSED_RECHECK_MS = 60_000;

interface ReplyRow {
  id: string;
  conversation_id: string;
  reply_to_message_id: string | null;
  channel_account_id: string;
  to_address: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  references_header: string | null;
  content_hash: string;
  status: ManualReply['status'];
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  channel_account_id: string;
  contact_id: string | null;
  company_id: string | null;
}

interface AnsweredRow {
  id: string;
  conversation_id: string;
  direction: string;
  classification: string | null;
  from_address: string | null;
  subject: string | null;
  rfc_message_id: string | null;
  in_reply_to: string | null;
}

/** Thrown inside the reserving transaction: the do-not-contact list now covers the recipient. */
class ReplyBlocked extends Error {
  constructor(readonly rule: string) {
    super(rule);
  }
}

export interface ReplyDeps {
  db: DatabaseSync;
  now: () => Date;
  audit: AuditLog;
  ledger: SideEffectLedger;
  jobs: JobQueue;
  policy: ContactPolicy;
  /** The sending channel of an active email account, or undefined. */
  channel: (accountId: string) => MessageChannel | undefined;
  addressOf: (accountId: string) => string | null;
  paused: () => boolean;
  logger: Logger;
  changed: (entities: ChangedEntity[]) => void;
}

/**
 * Replies written and sent from the inbox (ADR 031, docs/01 "Inbox: manual response drafting").
 * A one-step workflow: the reply row holds what is sent and where it stands, the side-effect ledger
 * guards the send, and a job carries it across restarts. Pressing Send is the approval.
 */
export class ReplyService {
  constructor(private readonly d: ReplyDeps) {}

  jobTypes(): JobType<never>[] {
    const type: JobType<{ replyId: string }> = {
      type: JOB_REPLY,
      payload: z.object({ replyId: z.uuid() }),
      sideEffecting: true,
      concurrency: 1,
      maxAttempts: 6,
      handler: ({ replyId }, ctx) => this.deliver(replyId, ctx),
    };
    return [type] as unknown as JobType<never>[];
  }

  /** What the thread view needs to write a reply: whom it answers, and replies not yet sent. */
  forConversation(conversationId: string): Pick<Conversation, 'replyTarget' | 'replies'> {
    const target = this.d.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? AND direction = 'inbound' AND classification = 'reply'
           AND from_address IS NOT NULL
         ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
      )
      .get(conversationId) as AnsweredRow | undefined;
    const replies = this.d.db
      .prepare(
        `SELECT * FROM manual_replies WHERE conversation_id = ? AND status != 'sent' ORDER BY created_at, id`,
      )
      .all(conversationId) as unknown as ReplyRow[];
    return {
      replyTarget: target
        ? { messageId: target.id, address: target.from_address ?? '', subject: replySubject(target.subject) }
        : null,
      replies: replies.map(toDto),
    };
  }

  send(
    input: { conversationId: string; messageId: string; subject: string; body: string },
    ctx: CommandContext,
  ): ManualReply {
    const reply = transaction(this.d.db, () => {
      const conversation = this.conversation(input.conversationId);
      const answered = this.d.db.prepare('SELECT * FROM messages WHERE id = ?').get(input.messageId) as
        AnsweredRow | undefined;
      if (
        !answered ||
        answered.conversation_id !== conversation.id ||
        answered.direction !== 'inbound' ||
        !answered.from_address
      ) {
        throw new RpcError('NOT_FOUND', 'Message not found', 'message.notFound');
      }
      this.checkCanSend(conversation);
      const busy = this.d.db
        .prepare(
          `SELECT 1 FROM manual_replies WHERE conversation_id = ? AND status IN ('sending', 'unknown') LIMIT 1`,
        )
        .get(conversation.id);
      // One at a time: a second reply while the first may still be on its way could be a duplicate.
      if (busy) throw new RpcError('CONFLICT', 'A reply is still on its way', 'reply.pending');
      const to = normalizeEmail(answered.from_address) ?? answered.from_address.trim().toLowerCase();
      const blocked = this.d.policy.replySuppression(to, conversation.contact_id, conversation.company_id);
      if (blocked) throw new RpcError('CONFLICT', 'On the do-not-contact list', `reply.${blocked}`);

      const id = uuidv7();
      const ts = this.d.now().toISOString();
      const references = [answered.in_reply_to, answered.rfc_message_id]
        .filter((v): v is string => !!v)
        .join(' ');
      this.d.db
        .prepare(
          `INSERT INTO manual_replies (id, conversation_id, reply_to_message_id, channel_account_id, to_address,
                                       subject, body, in_reply_to, references_header, content_hash, status,
                                       created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
        )
        .run(
          id,
          conversation.id,
          answered.id,
          conversation.channel_account_id,
          to,
          input.subject,
          input.body,
          answered.rfc_message_id,
          references || null,
          contentHash(to, input.subject, input.body),
          ts,
          ts,
        );
      this.d.jobs.enqueue(
        JOB_REPLY,
        { replyId: id },
        { dedupeKey: `reply:${id}`, correlationId: ctx.correlationId },
      );
      return this.row(id);
    });
    this.d.changed(['conversation']);
    return toDto(reply);
  }

  /** Sends again a reply that was verified not sent (same intent: the ledger allows it from not_sent). */
  retry(id: string, ctx: CommandContext): ManualReply {
    const reply = transaction(this.d.db, () => {
      const row = this.row(id);
      if (row.status !== 'failed') throw new RpcError('CONFLICT', 'Not a failed reply', 'reply.notFailed');
      this.checkCanSend(this.conversation(row.conversation_id));
      this.update(id, { status: 'sending', error_class: null });
      this.d.jobs.enqueue(
        JOB_REPLY,
        { replyId: id },
        { dedupeKey: `reply:${id}`, correlationId: ctx.correlationId },
      );
      return this.row(id);
    });
    this.d.changed(['conversation']);
    return toDto(reply);
  }

  /** The job for a reply, while it may be sending or checking (Needs attention must wait). */
  activeJob(replyId: string) {
    const job = this.d.jobs.latestFor(JOB_REPLY, 'replyId', replyId);
    return job && (job.status === 'pending' || job.status === 'running') ? job : undefined;
  }

  /** A person settled an uncertain reply under Needs attention (ADR 018 `user_confirmation`). */
  resolved(effect: SideEffectRow, outcome: 'completed' | 'not_sent'): void {
    const row = this.find(effect.scope_id);
    if (!row) return;
    if (outcome === 'completed') this.markSent(row, effect);
    else {
      this.update(row.id, { status: 'failed', error_class: 'user_confirmed_not_sent' });
      this.d.changed(['conversation']);
    }
  }

  async deliver(replyId: string, ctx: JobContext): Promise<JobOutcome> {
    const row = this.find(replyId);
    // Sent, or failed and waiting for the user: nothing to do.
    if (!row || (row.status !== 'sending' && row.status !== 'unknown')) return;
    if (this.d.paused()) return { continueAt: new Date(this.d.now().getTime() + PAUSED_RECHECK_MS) };
    const channel = this.d.channel(row.channel_account_id);
    if (!channel) {
      // The account was disconnected or needs signing in again: verified nothing left.
      if (row.status === 'sending') this.fail(row, 'account_unavailable', ctx.correlationId);
      else throw new RetryableError('account_unavailable');
      return;
    }
    const conversation = this.conversation(row.conversation_id);
    const audit = (
      status: 'planned' | 'completed' | 'failed' | 'unknown',
      extra: Record<string, unknown> = {},
    ) =>
      this.d.audit.record({
        actorType: 'user',
        actionType: 'message.reply',
        objectType: 'conversation',
        objectId: row.conversation_id,
        status,
        payload: { replyId: row.id, channel: 'email', attempt: ctx.attempt, ...extra },
        correlationId: ctx.correlationId,
      });

    let outcome;
    try {
      outcome = await executeSideEffect({
        ledger: this.d.ledger,
        now: this.d.now,
        channel,
        intent: {
          scopeId: row.id,
          stepPosition: 1,
          channel: 'email',
          actionType: REPLY_ACTION,
          target: row.to_address,
        },
        workflowRunId: row.id,
        message: {
          target: row.to_address,
          recipientName: null,
          subject: row.subject,
          body: row.body,
          contentHash: row.content_hash,
          inReplyTo: row.in_reply_to,
          references: row.references_header,
        },
        signal: ctx.signal,
        // In the reserving transaction: an opt-out that arrived meanwhile still stops it.
        guard: () => {
          const blocked = this.d.policy.replySuppression(
            row.to_address,
            conversation.contact_id,
            conversation.company_id,
          );
          if (blocked) throw new ReplyBlocked(blocked);
          audit('planned');
        },
        onReconciled: (settled) =>
          audit(settled === 'completed' ? 'completed' : 'failed', {
            reconciled: true,
            ...(settled === 'not_sent' ? { errorClass: 'reconciled_not_sent' } : {}),
          }),
        onSendError: (error) =>
          this.d.logger.warn(
            { event: 'reply.send_threw', replyId: row.id, error: String(error) },
            'send threw; outcome unknown',
          ),
      });
    } catch (error) {
      if (!(error instanceof ReplyBlocked)) throw error;
      this.fail(row, error.rule, ctx.correlationId);
      return;
    }

    switch (outcome.outcome) {
      case 'pending':
        return { continueAt: outcome.retryAt };
      case 'completed': {
        transaction(this.d.db, () => {
          if (!outcome.alreadyDone) audit('completed');
          const effect = this.d.ledger.get(outcome.sideEffectId);
          if (effect) this.markSent(row, effect);
        });
        return;
      }
      case 'not_sent':
        transaction(this.d.db, () => {
          audit('failed', { errorClass: outcome.errorClass });
          this.update(row.id, { status: 'failed', error_class: outcome.errorClass });
        });
        this.d.changed(['conversation', 'activity']);
        return;
      case 'unknown':
        transaction(this.d.db, () => {
          audit('unknown', { errorClass: outcome.errorClass });
          this.update(row.id, { status: 'unknown', error_class: outcome.errorClass });
        });
        this.d.changed(['conversation', 'activity']);
        // Possibly delivered: the retry reconciles through the ledger, it never sends blindly.
        // When the attempts run out it waits for the user under Needs attention.
        throw new RetryableError('send_unknown', outcome.errorClass);
    }
  }

  private checkCanSend(conversation: ConversationRow): void {
    if (this.d.paused()) throw new RpcError('CONFLICT', 'Everything is paused', 'reply.paused');
    if (!this.d.channel(conversation.channel_account_id)) {
      throw new RpcError('CONFLICT', 'The account cannot send', 'reply.accountUnavailable');
    }
  }

  private fail(row: ReplyRow, errorClass: string, correlationId: string): void {
    transaction(this.d.db, () => {
      this.update(row.id, { status: 'failed', error_class: errorClass });
      this.d.audit.record({
        actorType: 'system',
        actionType: 'message.reply',
        objectType: 'conversation',
        objectId: row.conversation_id,
        status: 'failed',
        payload: { replyId: row.id, channel: 'email', errorClass },
        correlationId,
      });
    });
    this.d.changed(['conversation', 'activity']);
  }

  /** Sent: the reply joins the thread as an outgoing message, so an answer to it matches by thread. */
  private markSent(row: ReplyRow, effect: SideEffectRow): void {
    transaction(this.d.db, () => {
      const refs = JSON.parse(effect.external_refs) as Record<string, unknown>;
      const address = this.d.addressOf(row.channel_account_id) ?? '';
      const rfcId =
        typeof refs.messageId === 'string' ? refs.messageId : messageIdFor(effect.idempotency_key, address);
      const ts = this.d.now().toISOString();
      const exists = this.d.db
        .prepare(
          `SELECT 1 FROM messages WHERE conversation_id = ? AND rfc_message_id = ? AND direction = 'outbound'`,
        )
        .get(row.conversation_id, rfcId);
      if (!exists) {
        this.d.db
          .prepare(
            `INSERT INTO messages (id, conversation_id, direction, rfc_message_id, in_reply_to, from_address, subject,
                                   body, occurred_at, created_at)
             VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(uuidv7(), row.conversation_id, rfcId, row.in_reply_to, address, row.subject, row.body, ts, ts);
        this.d.db
          .prepare('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?')
          .run(ts, ts, row.conversation_id);
      }
      this.update(row.id, { status: 'sent', error_class: null });
    });
    this.d.changed(['conversation', 'activity']);
  }

  private conversation(id: string): ConversationRow {
    const row = this.d.db
      .prepare('SELECT id, channel_account_id, contact_id, company_id FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined;
    if (!row) throw new RpcError('NOT_FOUND', 'Conversation not found', 'conversation.notFound');
    return row;
  }

  private find(id: string): ReplyRow | undefined {
    return this.d.db.prepare('SELECT * FROM manual_replies WHERE id = ?').get(id) as ReplyRow | undefined;
  }

  private row(id: string): ReplyRow {
    const row = this.find(id);
    if (!row) throw new RpcError('NOT_FOUND', 'Reply not found', 'reply.notFound');
    return row;
  }

  private update(id: string, v: { status: ReplyRow['status']; error_class: string | null }): void {
    this.d.db
      .prepare('UPDATE manual_replies SET status = ?, error_class = ?, updated_at = ? WHERE id = ?')
      .run(v.status, v.error_class, this.d.now().toISOString(), id);
  }
}

/** "Re: " in front once; a subject that already starts with it is kept as it is. */
export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  return /^re\s*:/i.test(s) ? s : `Re: ${s}`.trim();
}

function contentHash(to: string, subject: string, body: string): string {
  return createHash('sha256')
    .update(JSON.stringify([to, subject, body]))
    .digest('hex');
}

function toDto(r: ReplyRow): ManualReply {
  return {
    id: r.id,
    to: r.to_address,
    subject: r.subject,
    body: r.body,
    status: r.status,
    errorClass: r.error_class,
    createdAt: r.created_at,
  };
}
