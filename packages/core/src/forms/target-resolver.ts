import { randomUUID } from 'node:crypto';
import {
  formFieldMeaningSchema,
  type Logger,
  type ResolveTargetRequest,
  type ResolveTargetResult,
} from '@tabreach/protocol';
import { z } from 'zod';
import type { AiGateway } from '../ai/gateway.js';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';
import type { AuditLog } from '../audit/audit-log.js';

/** Meanings the resolver may choose: everything but a consent (never AI's decision, FR-FRM-006). */
const MEANINGS = formFieldMeaningSchema.options.filter((m) => m !== 'consent');
const meaningChoice = z.enum(MEANINGS as [string, ...string[]]).nullable();

const fieldsInput = z.object({
  fields: z.array(
    z.object({
      ref: z.number(),
      label: z.string(),
      placeholder: z.string(),
      name: z.string(),
      type: z.string(),
    }),
  ),
  nonce: z.string(),
});
const fieldsOutput = z.object({
  fields: z.array(z.object({ ref: z.number().int(), meaning: meaningChoice })).max(30),
});

/** ADR 013: a meaning per field from a closed list, or null. Version 1. */
export const resolveFormFields: PromptTemplate<z.infer<typeof fieldsInput>, z.infer<typeof fieldsOutput>> = {
  key: 'form.fields',
  version: 1,
  purpose: 'Say what the unrecognized fields of a website contact form ask for, from a closed list.',
  useCase: 'classification',
  input: fieldsInput,
  output: fieldsOutput,
  maxTokens: 1_500,
  build: ({ fields, nonce }) => ({
    system: [
      'You help fill in a business contact form on a company website with the sender’s own details.',
      `For each field, choose what it asks for: one of ${MEANINGS.join(', ')} — or null when it asks for`,
      'anything else (an order number, a budget, a date, a choice) or you are not sure.',
      'name is the whole name; firstName and lastName are the parts; message is the text of the enquiry.',
      'Answer only with the fields you were given, by their ref. Never invent fields or values.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: `Fields of the form (ref, label, placeholder, name, type):\n\n${untrusted(
      'form-fields',
      fields.map((f) => `${f.ref} | ${f.label} | ${f.placeholder} | ${f.name} | ${f.type}`).join('\n'),
      nonce,
    )}`,
  }),
};

const linksInput = z.object({
  links: z.array(z.object({ ref: z.number(), text: z.string(), path: z.string() })),
  nonce: z.string(),
});
const linksOutput = z.object({ ref: z.number().int().nullable() });

/** ADR 013: the one link most likely to lead to the company's contact form, or null. Version 1. */
export const resolveContactLink: PromptTemplate<z.infer<typeof linksInput>, z.infer<typeof linksOutput>> = {
  key: 'form.contactLink',
  version: 1,
  purpose: 'Pick the link of a company website that leads to its contact form, from a closed list.',
  useCase: 'classification',
  input: linksInput,
  output: linksOutput,
  maxTokens: 500,
  build: ({ links, nonce }) => ({
    system: [
      'You find where a company website lets visitors write to the company (a contact or enquiry form).',
      'Choose the ref of the one link most likely to lead there, or null if none does.',
      'Never choose login, careers, shop, newsletter or legal pages.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: `Links of the website (ref | text | path):\n\n${untrusted(
      'site-links',
      links.map((l) => `${l.ref} | ${l.text} | ${l.path}`).join('\n'),
      nonce,
    )}`,
  }),
};

/**
 * Core's side of `ai.resolveTarget` (ADR 013, Phase 6c): one bounded AI call, its answer checked
 * against the candidates the worker sent, recorded without page content (ADR 022). Without a key,
 * over budget or on a provider failure the answer is "not available" and the worker goes on
 * without it (a required field it cannot fill goes to the person).
 */
export class TargetResolver {
  constructor(private readonly d: { gateway: AiGateway; audit: AuditLog; logger: Logger }) {}

  async resolve(
    req: ResolveTargetRequest,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<ResolveTargetResult> {
    const none: ResolveTargetResult = { available: false, meanings: [], link: null };
    if (!this.d.gateway.settings().keySet) return none;
    try {
      if (req.kind === 'form_fields') {
        const refs = new Set(req.fields.map((f) => f.ref));
        const out = await this.d.gateway.run(
          resolveFormFields,
          { fields: req.fields, nonce: randomUUID() },
          { correlationId, signal },
        );
        const meanings = out.fields
          .filter((f) => refs.has(f.ref))
          .map((f) => ({
            ref: f.ref,
            meaning: f.meaning as ResolveTargetResult['meanings'][number]['meaning'],
          }));
        this.record(req.kind, correlationId, {
          candidates: refs.size,
          chosen: meanings.filter((m) => m.meaning).length,
        });
        return { available: true, meanings, link: null };
      }
      const out = await this.d.gateway.run(
        resolveContactLink,
        { links: req.links, nonce: randomUUID() },
        { correlationId, signal },
      );
      const link = out.ref !== null && req.links.some((l) => l.ref === out.ref) ? out.ref : null;
      this.record(req.kind, correlationId, { candidates: req.links.length, chosen: link === null ? 0 : 1 });
      return { available: true, meanings: [], link };
    } catch (error) {
      this.d.logger.warn(
        { event: 'ai.resolve_failed', kind: req.kind, correlationId, err: error },
        'not resolved',
      );
      return none;
    }
  }

  private record(
    kind: ResolveTargetRequest['kind'],
    correlationId: string,
    counts: Record<string, number>,
  ): void {
    this.d.audit.record({
      actorType: 'system',
      actionType: 'ai.target_resolved',
      objectType: 'settings',
      payload: { kind, ...counts },
      correlationId,
    });
  }
}
