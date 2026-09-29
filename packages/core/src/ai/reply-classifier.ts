import type { DatabaseSync } from 'node:sqlite';
import { replyLabelSchema, type ChangedEntity, type Logger } from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import { PermanentError, RetryableError, type JobType } from '../jobs/dispatcher.js';
import type { JobQueue } from '../jobs/queue.js';
import type { SuppressionService } from '../suppressions/suppression-service.js';
import { AiGateway } from './gateway.js';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from './prompts.js';
import { AiError } from './provider.js';

export const JOB_CLASSIFY = 'reply.classify';

const input = z.object({
  subject: z.string().max(500).nullable(),
  text: z.string().max(20_000),
  nonce: z.string(),
});
const output = z.object({
  label: replyLabelSchema,
  confidence: z.number().min(0).max(1),
  /** One short sentence; shown to the user, never acted on. */
  reason: z.string().max(300),
});

/** docs/14 "Classification", docs/15 "AI use cases". Version 1. */
export const classifyReply: PromptTemplate<z.infer<typeof input>, z.infer<typeof output>> = {
  key: 'reply.classify',
  version: 1,
  purpose: 'Label a reply to an outreach email so the user sees intent and opt-outs are honoured.',
  useCase: 'classification',
  input,
  output,
  maxTokens: 300,
  build: ({ subject, text, nonce }) => ({
    system: [
      'You label replies to a business outreach email.',
      'Labels: interested (wants to talk, asks for details, proposes a time); not_interested (declines, no need);',
      'opt_out (asks to stop emailing, to be removed or unsubscribed, or objects to being contacted);',
      'out_of_office (an automatic absence notice); other (anything else, e.g. forwarding to a colleague).',
      'If the reply both declines and asks not to be contacted again, choose opt_out.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: `Label this reply.\n\n${untrusted('email-reply', `Subject: ${subject ?? ''}\n\n${text}`, nonce)}`,
  }),
};

/** Labels a stored reply; an opt-out adds the sender to the do-not-contact list (FR-POL-005). */
export class ReplyClassifier {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      gateway: AiGateway;
      jobs: JobQueue;
      suppressions: SuppressionService;
      audit: AuditLog;
      logger: Logger;
      changed: (entities: ChangedEntity[]) => void;
    },
  ) {}

  enqueue(messageId: string): void {
    // Without a key nothing is sent anywhere; replies simply stay unlabelled.
    if (!this.d.gateway.settings().keySet) return;
    this.d.jobs.enqueue(JOB_CLASSIFY, { messageId }, { dedupeKey: `classify:${messageId}` });
  }

  jobTypes(): JobType<never>[] {
    const type: JobType<{ messageId: string }> = {
      type: JOB_CLASSIFY,
      payload: z.object({ messageId: z.uuid() }),
      sideEffecting: false,
      concurrency: 2,
      maxAttempts: 5,
      handler: ({ messageId }, ctx) => this.classify(messageId, ctx.correlationId, ctx.signal),
    };
    return [type] as unknown as JobType<never>[];
  }

  async classify(messageId: string, correlationId: string, signal: AbortSignal): Promise<void> {
    const m = this.d.db
      .prepare(
        `SELECT m.id, m.subject, m.body, m.from_address, m.ai_label, m.classification FROM messages m WHERE m.id = ?`,
      )
      .get(messageId) as
      | {
          id: string;
          subject: string | null;
          body: string | null;
          from_address: string | null;
          ai_label: string | null;
          classification: string | null;
        }
      | undefined;
    if (!m || m.ai_label || m.classification !== 'reply') return;
    let result;
    try {
      result = await this.d.gateway.run(
        classifyReply,
        { subject: m.subject, text: m.body ?? '', nonce: AiGateway.nonce() },
        { correlationId, signal },
      );
    } catch (error) {
      if (error instanceof AiError) {
        if (error.retryable) throw new RetryableError(`ai_${error.kind}`);
        if (error.kind === 'no_key' || error.kind === 'budget') return; // the user turned AI off or capped it
        throw new PermanentError(`ai_${error.kind}`);
      }
      throw error;
    }
    this.d.db
      .prepare('UPDATE messages SET ai_label = ?, ai_confidence = ?, ai_template = ? WHERE id = ?')
      .run(result.label, result.confidence, `${classifyReply.key}@${classifyReply.version}`, m.id);
    this.d.audit.record({
      actorType: 'ai',
      actionType: 'message.classified',
      objectType: 'conversation',
      payload: {
        messageId: m.id,
        label: result.label,
        template: `${classifyReply.key}@${classifyReply.version}`,
      },
      correlationId,
    });
    if (result.label === 'opt_out' && m.from_address) {
      // Stopping is always the safe direction: an opt-out is honoured whatever the confidence.
      this.d.suppressions.addAutomatic('email', m.from_address, 'opt_out', { correlationId });
      this.d.changed(['suppression']);
    }
    this.d.changed(['conversation', 'activity']);
  }
}
