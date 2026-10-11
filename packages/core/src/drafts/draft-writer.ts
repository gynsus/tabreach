import type { Logger } from '@tabreach/protocol';
import { z } from 'zod';
import { AiGateway } from '../ai/gateway.js';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';
import { AiError, type AiErrorKind } from '../ai/provider.js';
import { RetryableError } from '../jobs/dispatcher.js';
import type { CampaignResearch, ResearchContext } from '../research/campaign-research.js';
import type { ResearchService } from '../research/research-service.js';

const input = z.object({
  /** The campaign's goal (docs/17), in the user's words; may be empty. */
  goal: z.string(),
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
 * Version 3: the campaign's goal.
 */
export const writeDraft: PromptTemplate<z.infer<typeof input>, WrittenDraft> = {
  key: 'draft.write',
  version: 3,
  purpose: 'Write one personalised outreach email from the sender instructions and verified research facts.',
  useCase: 'drafting',
  input,
  output,
  maxTokens: 6_000,
  build: ({ goal, instructions, maxLength, recipient, facts, previous, nonce }) => ({
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
      ...(goal.trim() ? [`Campaign goal (what the sender wants to achieve):\n${goal.trim()}`, ''] : []),
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

/** How often a message held by a used-up AI budget looks again. */
const BUDGET_RECHECK_MS = 60 * 60_000;

export interface DraftRequest {
  companyId: string | null;
  /** The campaign's goal, ICP and what to look for: the research the message relies on is asked with them. */
  context: ResearchContext;
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
      campaignResearch: CampaignResearch;
      now: () => Date;
      logger: Logger;
    },
  ) {}

  async write(req: DraftRequest, signal: AbortSignal, correlationId: string): Promise<DraftResult> {
    const research = req.companyId ? this.research(req.companyId, req.context, correlationId) : null;
    if (research?.kind === 'wait') return { kind: 'wait', until: research.until };
    const facts = research?.kind === 'facts' ? research.facts : [];
    const refs = facts.map((f, i) => ({ ref: `F${i + 1}`, ...f }));
    let draft: WrittenDraft;
    try {
      draft = await this.d.ai.run(
        writeDraft,
        {
          goal: req.context.goal,
          instructions: req.instructions,
          stepNumber: req.stepNumber,
          maxLength: req.maxLength,
          recipient: req.recipient,
          facts: refs.map(({ ref, claim, quote }) => ({ ref, claim, quote })),
          previous: req.previous,
          nonce: AiGateway.nonce(),
        },
        { correlationId, signal, campaignId: req.context.campaignId },
      );
    } catch (error) {
      if (error instanceof AiError) {
        // A used-up budget is the user's to raise: the message waits for it rather than failing.
        if (error.kind === 'budget')
          return { kind: 'wait', until: new Date(this.d.now().getTime() + BUDGET_RECHECK_MS) };
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
      researchRunId: research?.kind === 'facts' ? research.runId : null,
      model: this.d.ai.settings().models.drafting,
      template: `${writeDraft.key}@${writeDraft.version}`,
    };
  }

  /**
   * The facts a message relies on: research asked with the campaign's context while it is fresh
   * (started when there is none); without it, the latest facts there are, or none.
   */
  private research(
    companyId: string,
    context: ResearchContext,
    correlationId: string,
  ):
    | { kind: 'facts'; runId: string; facts: { id: string; claim: string; quote: string }[] }
    | { kind: 'wait'; until: Date }
    | { kind: 'none' } {
    const need = this.d.campaignResearch.need(companyId, context, correlationId);
    if (need.kind === 'wait') return need;
    if (need.kind === 'ready')
      return { kind: 'facts', runId: need.run.id, facts: this.d.research.factsOf(need.run.id) };
    const fallback = need.stale
      ? { runId: need.stale.id, facts: this.d.research.factsOf(need.stale.id) }
      : this.d.research.latestFacts(companyId);
    return fallback ? { kind: 'facts', ...fallback } : { kind: 'none' };
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
