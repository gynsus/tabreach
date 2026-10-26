import { RpcError, type ClaimCheck, type Language } from '@tabreach/protocol';
import { z } from 'zod';
import { AiGateway } from '../ai/gateway.js';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';
import { AiError } from '../ai/provider.js';
import type { ClaimMaterial } from '../campaigns/engine.js';

const input = z.object({
  language: z.enum(['en', 'ru']),
  subject: z.string().nullable(),
  body: z.string(),
  facts: z.array(z.object({ ref: z.string(), claim: z.string(), quote: z.string() })),
  recipient: z.string(),
  instructions: z.string(),
  previous: z.array(z.string()),
  nonce: z.string(),
});
const output = z.object({
  flags: z
    .array(
      z.object({
        /** Copied from the message, word for word. */
        text: z.string().min(1).max(500),
        problem: z.string().min(1).max(400),
        suggestion: z.string().max(600),
      }),
    )
    .max(10),
});

const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', ru: 'Russian' };

/**
 * docs/22 Phase 9d: reads a drafted message against what it may rest on and lists the statements
 * about the recipient or their company that nothing supports. The deterministic draft checks stay
 * as they are; this reading only adds findings for the person who approves.
 */
export const checkClaims: PromptTemplate<z.infer<typeof input>, z.infer<typeof output>> = {
  key: 'draft.claims',
  version: 1,
  purpose:
    'Find statements in an outreach message that the research facts and the sender material do not support.',
  useCase: 'drafting',
  input,
  output,
  maxTokens: 3_000,
  build: ({ language, subject, body, facts, recipient, instructions, previous, nonce }) => ({
    system: [
      'You review one business outreach message before the sender approves it.',
      'Find statements about the recipient, their company, their customers, results or events that are not',
      'supported by the research facts, the recipient fields, the sender instructions or the earlier messages.',
      'A statement is supported only when that material says it; a plausible guess, an exaggeration or a',
      'specific detail (number, date, name, place, product, achievement) not in the material is unsupported.',
      "The sender's own offer, opinions, questions and polite phrases are not claims about the recipient: do not flag them.",
      'For each finding: text is the exact passage copied character for character from the message (one',
      'sentence or less); problem says briefly what the material does not support; suggestion is a rewording',
      'of that passage that keeps its purpose and says only what the material supports (empty to remove it).',
      'Return no findings when everything is supported. Never rewrite the whole message.',
      `Write problem and suggestion in ${LANGUAGE_NAMES[language]}; keep text in the language of the message,`,
      'and write each suggestion in the language of the message too.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: [
      untrusted('message', `Subject: ${subject ?? ''}\n${body}`, nonce),
      '',
      `Recipient fields: ${recipient || 'none'}`,
      '',
      `Sender instructions or template:\n${instructions.trim() || 'none'}`,
      '',
      facts.length
        ? `Research facts (verified quotes from the company's website):\n${facts
            .map((f) => untrusted(f.ref, `${f.claim}\nQuote: ${f.quote}`, nonce))
            .join('\n')}`
        : 'No research facts are available.',
      ...(previous.length
        ? [
            '',
            'Earlier messages the sender already sent:',
            ...previous.map((p, i) => `--- Message ${i + 1}\n${p}`),
          ]
        : []),
    ].join('\n'),
  }),
};

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export class ClaimChecker {
  constructor(
    private readonly d: {
      ai: Pick<AiGateway, 'run'>;
      /** The draft behind a pending approval, or undefined. */
      draftOf: (approvalId: string) => { draftId: string; campaignId: string } | undefined;
      material: (draftId: string) => ClaimMaterial | undefined;
      /** Whether an AI key is stored: without one nothing is called. */
      aiReady: () => boolean;
    },
  ) {}

  async check(
    req: { approvalId: string; language: Language },
    signal: AbortSignal,
    correlationId: string,
  ): Promise<ClaimCheck> {
    const pending = this.d.draftOf(req.approvalId);
    const m = pending && this.d.material(pending.draftId);
    if (!pending || !m) throw new RpcError('NOT_FOUND', 'No such approval', 'approval.notFound');
    if (!this.d.aiReady()) throw new RpcError('CONFLICT', 'No AI key', 'ai.no_key');
    let out: z.infer<typeof output>;
    try {
      out = await this.d.ai.run(
        checkClaims,
        {
          language: req.language,
          subject: m.subject,
          body: m.body,
          facts: m.facts.map((f, i) => ({ ref: `F${i + 1}`, ...f })),
          recipient: [
            m.recipient.name,
            m.recipient.jobTitle,
            m.recipient.companyName,
            m.recipient.city,
            m.recipient.country,
          ]
            .filter(Boolean)
            .join(', '),
          instructions: m.instructions,
          previous: m.previous.map((p) => `Subject: ${p.subject ?? ''}\n${p.body}`),
          nonce: AiGateway.nonce(),
        },
        { correlationId, signal, campaignId: pending.campaignId },
      );
    } catch (error) {
      if (error instanceof AiError) throw new RpcError('CONFLICT', 'AI could not answer', `ai.${error.kind}`);
      throw error;
    }
    // A finding must point at the message itself; one that quotes nothing in it is the model's own.
    const message = squash(`${m.subject ?? ''}\n${m.body}`);
    const seen = new Set<string>();
    const flags = out.flags
      .map((f) => ({ text: squash(f.text), problem: f.problem.trim(), suggestion: f.suggestion.trim() }))
      .filter((f) => f.text && message.includes(f.text) && !seen.has(f.text) && seen.add(f.text));
    return { contentHash: m.contentHash, flags, factCount: m.facts.length };
  }
}
