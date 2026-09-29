import type { Logger } from '@tabreach/protocol';
import { z } from 'zod';
import { AiGateway } from '../ai/gateway.js';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';
import { AiError, type AiErrorKind } from '../ai/provider.js';
import { RetryableError } from '../jobs/dispatcher.js';
import type { ResearchService } from '../research/research-service.js';

const input = z.object({
  instructions: z.string(),
  stepNumber: z.number().int().min(1),
  maxLength: z.number().int(),
  recipient: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    companyName: z.string().nullable(),
  }),
  facts: z.array(z.object({ ref: z.string(), claim: z.string(), quote: z.string() })),
  previous: z.array(z.object({ subject: z.string().nullable(), body: z.string() })),
  nonce: z.string(),
});
const output = z.object({
  subject: z.string().min(1).max(200),
  /** The message without a signature; TabReach appends the user's signature itself. */
  body: z.string().min(1).max(8_000),
  /** Refs (F1, F2, …) of the facts the message relies on. */
  usedFacts: z.array(z.string().max(20)).max(10),
});
export type WrittenDraft = z.infer<typeof output>;

/**
 * docs/15 "AI use cases: personalised draft", docs/17. Version 2: no fact refs or sign-off in the
 * text, and a first message does not pretend to continue a conversation (live check, DeepSeek).
 */
export const writeDraft: PromptTemplate<z.infer<typeof input>, WrittenDraft> = {
  key: 'draft.write',
  version: 2,
  purpose: 'Write one personalised outreach email from the sender instructions and verified research facts.',
  useCase: 'drafting',
  input,
  output,
  maxTokens: 6_000,
  build: ({ instructions, maxLength, recipient, facts, previous, nonce }) => ({
    system: [
      'You write one business outreach email on behalf of the sender, following the sender instructions.',
      'Write in the language of the sender instructions. Plain text, no Markdown, no placeholders.',
      'Do not write a signature, a sign-off name or a closing line such as "Best regards" or "С уважением":',
      'the sender signature, which has them, is added automatically.',
      'Never put fact refs (F1, F2, …) or brackets with them in the subject or the text; they are only for usedFacts.',
      'Personalise only with the facts listed and the recipient fields. Never state a number, name, date, place,',
      'product, customer or event that is not in the facts, the recipient fields or the sender instructions.',
      'If the facts give nothing useful, write a short honest message without personal specifics.',
      'No links or email addresses unless the sender instructions contain them.',
      `Keep the body under ${maxLength} characters. usedFacts lists the refs (F1, F2, …) of the facts you relied on.`,
      previous.length > 0
        ? 'This is a follow-up to the earlier messages shown; do not repeat them.'
        : 'This is the first message to this recipient: do not refer to any earlier contact or conversation.',
      UNTRUSTED_RULES,
    ]
      .filter(Boolean)
      .join(' '),
    user: [
      `Sender instructions:\n${instructions}`,
      '',
      `Recipient: ${[recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || 'unknown name'}` +
        `${recipient.jobTitle ? `, ${recipient.jobTitle}` : ''}` +
        `${recipient.companyName ? `, ${recipient.companyName}` : ''}`,
      '',
      facts.length
        ? `Facts about the recipient's company, from its website:\n${facts
            .map((f) => untrusted(f.ref, `${f.claim}\nQuote: ${f.quote}`, nonce))
            .join('\n')}`
        : 'No research facts are available.',
      ...(previous.length
        ? [
            '',
            'Earlier messages the sender already sent to this recipient:',
            ...previous.map((p, i) => `--- Message ${i + 1}\nSubject: ${p.subject ?? ''}\n${p.body}`),
          ]
        : []),
    ].join('\n'),
  }),
};

/** Research older than this is refreshed before a message relies on it. */
const RESEARCH_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** A failed research is not retried for every message: without it, drafts use no facts for a day. */
const FAILED_RESEARCH_BACKOFF_MS = 24 * 60 * 60_000;
const RESEARCH_POLL_MS = 20_000;
/** A research still running after this is not waited for: the message is written without it. */
const RESEARCH_MAX_WAIT_MS = 60 * 60_000;

export interface DraftRequest {
  companyId: string | null;
  instructions: string;
  stepNumber: number;
  maxLength: number;
  recipient: z.infer<typeof input>['recipient'];
  previous: { subject: string | null; body: string }[];
}

export type DraftResult =
  | {
      kind: 'ready';
      draft: WrittenDraft;
      facts: { id: string; claim: string; quote: string }[];
      researchRunId: string | null;
      model: string;
      /** `key@version` of the prompt that wrote it. */
      template: string;
    }
  | { kind: 'wait'; until: Date }
  | { kind: 'failed'; reason: AiErrorKind };

/**
 * Writes an AI draft (docs/17): research first — started when the company has none, or only an old
 * one — then one model call. The facts go in as untrusted material; only the refs the model says it
 * used are kept, and the checks decide what the draft may claim.
 */
export class DraftWriter {
  constructor(
    private readonly d: {
      ai: AiGateway;
      research: ResearchService;
      now: () => Date;
      logger: Logger;
    },
  ) {}

  async write(req: DraftRequest, signal: AbortSignal, correlationId: string): Promise<DraftResult> {
    const research = req.companyId ? this.research(req.companyId, correlationId) : { kind: 'none' as const };
    if (research.kind === 'wait')
      return { kind: 'wait', until: new Date(this.d.now().getTime() + RESEARCH_POLL_MS) };
    const facts = research.kind === 'facts' ? research.facts : [];
    const refs = facts.map((f, i) => ({ ref: `F${i + 1}`, ...f }));
    let draft: WrittenDraft;
    try {
      draft = await this.d.ai.run(
        writeDraft,
        {
          instructions: req.instructions,
          stepNumber: req.stepNumber,
          maxLength: req.maxLength,
          recipient: req.recipient,
          facts: refs.map(({ ref, claim, quote }) => ({ ref, claim, quote })),
          previous: req.previous,
          nonce: AiGateway.nonce(),
        },
        { correlationId, signal },
      );
    } catch (error) {
      if (error instanceof AiError) {
        if (error.retryable) throw new RetryableError(`ai_${error.kind}`);
        return { kind: 'failed', reason: error.kind };
      }
      throw error;
    }
    const used = new Set(draft.usedFacts.map((r) => /F(\d+)/.exec(r)?.[0]).filter(Boolean));
    return {
      kind: 'ready',
      draft,
      facts: refs.filter((f) => used.has(f.ref)).map(({ id, claim, quote }) => ({ id, claim, quote })),
      researchRunId: research.kind === 'facts' ? research.runId : null,
      model: this.d.ai.settings().models.drafting,
      template: `${writeDraft.key}@${writeDraft.version}`,
    };
  }

  private research(
    companyId: string,
    correlationId: string,
  ):
    | { kind: 'facts'; runId: string; facts: { id: string; claim: string; quote: string }[] }
    | { kind: 'wait' }
    | { kind: 'none' } {
    const now = this.d.now().getTime();
    // A run whose job is gone is failed first, so a draft never waits on it (audit 4.5).
    this.d.research.resync();
    const [latest] = this.d.research.list(companyId);
    if (
      latest &&
      (latest.status === 'pending' || latest.status === 'running') &&
      now - new Date(latest.startedAt).getTime() < RESEARCH_MAX_WAIT_MS
    )
      return { kind: 'wait' };
    const found = this.d.research.latestFacts(companyId);
    const completedAt = found
      ? this.d.research.list(companyId).find((r) => r.id === found.runId)?.finishedAt
      : null;
    if (found && completedAt && now - new Date(completedAt).getTime() < RESEARCH_MAX_AGE_MS)
      return { kind: 'facts', runId: found.runId, facts: found.facts };
    const recentFailure =
      latest?.status === 'failed' && now - new Date(latest.startedAt).getTime() < FAILED_RESEARCH_BACKOFF_MS;
    if (!recentFailure) {
      try {
        this.d.research.start({ companyId }, { correlationId }, 'system');
        return { kind: 'wait' };
      } catch (error) {
        // No website, or no AI key: write without facts rather than not at all.
        this.d.logger.info({ event: 'draft.research_unavailable', companyId, correlationId }, String(error));
      }
    }
    return found ? { kind: 'facts', runId: found.runId, facts: found.facts } : { kind: 'none' };
  }
}

const FACT_REFS = /\s*[([](?:F\d+(?:\s*[,;]\s*F\d+)*)[)\]]/g;
const bare = (line: string) =>
  line
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * What the model wrote, tidied the way the prompt asks even when a model does not listen: fact refs
 * such as "(F3)" are removed, and a closing line that repeats the start of the signature is dropped.
 */
export function cleanDraftBody(body: string, signature: string): string {
  const lines = body.replace(FACT_REFS, '').trimEnd().split('\n');
  const first = bare(signature.trim().split('\n')[0] ?? '');
  const last = lines.at(-1);
  if (first && last !== undefined && bare(last) === first) lines.pop();
  return lines.join('\n').trim();
}

export function cleanSubject(subject: string): string {
  return subject.replace(FACT_REFS, '').trim();
}
