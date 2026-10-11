import { languageSchema } from '@tabreach/protocol';
import { z } from 'zod';
import { untrusted, UNTRUSTED_RULES, type PromptTemplate } from '../ai/prompts.js';

const input = z.object({
  person: z.object({ name: z.string(), jobTitle: z.string().nullable() }),
  company: z.object({ name: z.string(), site: z.string() }),
  /** The campaign's goal and what to look for (docs/16); the user's own words. */
  goal: z.string().nullable(),
  instructions: z.string().nullable(),
  language: languageSchema,
  /** Only pages of the company's own site that name the person. */
  pages: z
    .array(z.object({ ref: z.string(), url: z.string(), title: z.string().nullable(), text: z.string() }))
    .min(1),
  nonce: z.string(),
});

const output = z.object({
  personSummary: z.string().max(800),
  facts: z
    .array(
      z.object({
        claim: z.string().max(300),
        evidenceRef: z.string().max(300),
        quote: z.string().max(400),
      }),
    )
    .max(10),
  missingInformation: z.array(z.string().max(200)).max(5),
});
export type PersonSynthesis = z.infer<typeof output>;

const LANGUAGE_NAMES: Record<z.infer<typeof languageSchema>, string> = { en: 'English', ru: 'Russian' };

/**
 * Contact-level research (docs/16 "Research about a person"): what the company's own pages say
 * about one named person, as facts with verbatim quotes that are checked like company facts.
 */
export const synthesizePerson: PromptTemplate<z.infer<typeof input>, PersonSynthesis> = {
  key: 'research.person',
  version: 1,
  purpose: "Summarise what a company's own pages say about one named person, as verified facts.",
  useCase: 'research',
  input,
  output,
  maxTokens: 4_000,
  build: ({ person, company, goal, instructions, language, pages, nonce }) => ({
    system: [
      'You research one person for business outreach, using only the pages of their company provided.',
      'Facts: only statements the pages make about this person — their role, responsibilities, what they said,',
      'did, wrote or presented. Never facts about other people, even with the same first or last name, and nothing',
      'about the person from outside the pages: no guessed age, education, private life or contact details.',
      'Each fact gives the page ref (just E1, E2, …) and a quote copied character for character from that page.',
      'Missing information: what a salesperson would want to know about the person that the pages do not say.',
      'Limits: at most 10 facts and 5 missing items; a claim up to 300 characters, a quote up to 400, the summary up',
      `to 800. Write the summary, claims and missing items in ${LANGUAGE_NAMES[language]} as plain prose; quotes stay`,
      'exactly as on the page.',
      UNTRUSTED_RULES,
    ].join(' '),
    user: [
      `Person: ${person.name}${person.jobTitle ? `, ${person.jobTitle}` : ''}`,
      `Company: ${company.name} (${company.site})`,
      `Campaign goal: ${goal?.trim() || 'none given'}`,
      `What to look for: ${instructions?.trim() || 'nothing specific'}`,
      '',
      ...pages.map((p) => untrusted(`${p.ref} ${p.url}${p.title ? ` — ${p.title}` : ''}`, p.text, nonce)),
    ].join('\n'),
  }),
};

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Whether a page names the person: first and last name next to each other in either order, a
 * middle name or patronymic allowed between them; accents and case ignored. A first name alone
 * proves nothing.
 */
export function namesPerson(text: string, person: { first: string | null; last: string | null }): boolean {
  const first = person.first ? fold(person.first) : '';
  const last = person.last ? fold(person.last) : '';
  if (!first || !last) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const page = ` ${fold(text)} `;
  const between = '(?: \\S+)?';
  return new RegExp(
    ` ${esc(first)}${between} ${esc(last)} | ${esc(last)}${between} ${esc(first)} `,
    'u',
  ).test(page);
}
