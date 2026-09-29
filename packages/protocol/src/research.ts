import { z } from 'zod';

/** Research runs, evidence and facts (docs/16, docs/15 "Grounding verification"). */

export const qualificationSchema = z.enum(['match', 'possible_match', 'not_match', 'insufficient_data']);
export type Qualification = z.infer<typeof qualificationSchema>;

export const researchStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

export const evidenceSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  title: z.string().nullable(),
  capturedAt: z.iso.datetime(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const researchFactSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['fact', 'inference']),
  claim: z.string(),
  /** Facts: the verbatim quote that was found in the evidence text. */
  quote: z.string().nullable(),
  evidenceId: z.uuid().nullable(),
  /** False: the model's quote was not found in the source; never used as a fact. */
  verified: z.boolean(),
  /** Inferences: the facts they rest on. */
  basedOn: z.array(z.uuid()),
});
export type ResearchFact = z.infer<typeof researchFactSchema>;

export const researchRunSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  status: researchStatusSchema,
  /** Why it failed: a key such as `research.noWebsite`, `ai.no_key`. */
  error: z.string().nullable(),
  criteria: z.string().nullable(),
  summary: z.string().nullable(),
  qualification: qualificationSchema.nullable(),
  qualificationReason: z.string().nullable(),
  reasonToContact: z.string().nullable(),
  missingInformation: z.array(z.string()),
  template: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  pagesFetched: z.number().int().nonnegative(),
  pagesSkipped: z.number().int().nonnegative(),
});
export type ResearchRun = z.infer<typeof researchRunSchema>;

export const researchDetailSchema = researchRunSchema.extend({
  facts: z.array(researchFactSchema),
  evidence: z.array(evidenceSchema),
});
export type ResearchDetail = z.infer<typeof researchDetailSchema>;

export const researchStartSchema = z.object({
  companyId: z.uuid(),
  /** What the user looks for (ICP): location, company type, signals, exclusions. */
  criteria: z.string().trim().max(2_000).nullish(),
});
