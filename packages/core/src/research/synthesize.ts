import { languageSchema, qualificationSchema } from '@tabreach/protocol';
import { z } from 'zod';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';

const input = z.object({
  company: z.object({ name: z.string(), site: z.string() }),
  criteria: z.string().nullable(),
  language: languageSchema,
  pages: z
    .array(z.object({ ref: z.string(), url: z.string(), title: z.string().nullable(), text: z.string() }))
    .min(1),
  nonce: z.string(),
});

const output = z.object({
  companySummary: z.string().max(1_500),
  facts: z
    .array(
      z.object({
        claim: z.string().max(300),
        /** Which page it comes from: E1, E2, … (models sometimes add the URL; see pageForRef). */
        evidenceRef: z.string().max(300),
        /** Copied verbatim from that page's text; it is checked. */
        quote: z.string().max(400),
      }),
    )
    .max(20),
  inferences: z
    .array(z.object({ claim: z.string().max(300), basedOnFacts: z.array(z.number().int().min(0)).min(1) }))
    .max(10),
  qualification: qualificationSchema,
  qualificationReason: z.string().max(600),
  reasonToContact: z.string().max(600),
  missingInformation: z.array(z.string().max(200)).max(10),
});
export type Synthesis = z.infer<typeof output>;

const LANGUAGE_NAMES: Record<z.infer<typeof languageSchema>, string> = { en: 'English', ru: 'Russian' };

/** docs/15 example output, docs/16 "Research result". Version 2: the list and length limits are stated. Version 3: plain prose in the interface language. */
export const synthesizeResearch: PromptTemplate<z.infer<typeof input>, Synthesis> = {
  key: 'research.synthesize',
  version: 3,
  purpose: 'Summarise a company from its own web pages into verified facts, inferences and a qualification.',
  useCase: 'research',
  input,
  output,
  maxTokens: 8_000,
  build: ({ company, criteria, language, pages, nonce }) => ({
    system: [
      'You research a company for business outreach, using only the pages provided.',
      'Facts: statements the pages make. Each fact gives the page ref (just E1, E2, …) and a quote copied character for character',
      'from that page (a sentence or part of one, at least a few words). Never paraphrase inside the quote.',
      'Do not state anything the pages do not say: no guessed employee counts, revenue, customers or dates.',
      'Inferences: your interpretation, each based on facts by their index in the facts list.',
      'Qualification against the criteria: match, possible_match, not_match, or insufficient_data when the',
      'pages do not say enough (also when no criteria are given). Missing information: what the pages do not answer.',
      'Limits: at most 20 facts (the most useful for outreach), 10 inferences and 10 missing items; a claim up to',
      '300 characters, a quote up to 400, the summary up to 1500, each reason up to 600. Keep the answer compact.',
      `Write the summary, claims, inferences, reasons and missing items in ${LANGUAGE_NAMES[language]}, as plain`,
      'prose for a salesperson: no page refs such as E1 and no code words such as possible_match in the text.',
      'Quotes stay exactly as on the page, in the page language.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: [
      `Company: ${company.name} (${company.site})`,
      `Criteria: ${criteria?.trim() || 'none given'}`,
      '',
      ...pages.map((p) => untrusted(`${p.ref} ${p.url}${p.title ? ` — ${p.title}` : ''}`, p.text, nonce)),
    ].join('\n'),
  }),
};
