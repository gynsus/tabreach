import { z } from 'zod';
import { campaignConfigSchema } from './campaigns.js';
import { languageSchema } from './prospects.js';

// Campaign copilot (ADR 033) ------------------------------------------------------------------

/** One clarifying question; `options` are suggested answers, and every question also takes free text. */
export const copilotQuestionSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().max(300),
  kind: z.enum(['single', 'multi', 'text']),
  options: z.array(z.string().max(120)).max(6),
});
export type CopilotQuestion = z.infer<typeof copilotQuestionSchema>;

export const copilotIntentRequestSchema = z.object({
  /** What the user wants, in their own words. */
  description: z.string().trim().min(10).max(4_000),
  /** The interface language: the copilot's own summaries and questions are written in it. */
  language: languageSchema,
});

export const copilotIntentSchema = z.object({
  understanding: z.object({ goal: z.string(), audience: z.string(), offer: z.string() }),
  questions: z.array(copilotQuestionSchema).max(5),
  warnings: z.array(z.string()).max(5),
});
export type CopilotIntent = z.infer<typeof copilotIntentSchema>;

export const copilotPlanRequestSchema = z.object({
  description: z.string().trim().min(10).max(4_000),
  answers: z.array(z.object({ question: z.string().max(300), answer: z.string().max(1_000) })).max(8),
  language: languageSchema,
});

/** A plan, already validated and normalised by core; "Create draft" saves `config` as it is. */
export const copilotPlanSchema = z.object({
  name: z.string(),
  config: campaignConfigSchema,
  /** What the user asked for that the fixed rules do not allow, and what the plan does instead. */
  changes: z.array(z.object({ requested: z.string(), replacement: z.string() })),
  /** What the model assumed where the description left it open. */
  assumptions: z.array(z.string()),
  /** The model's own concerns (a broad ICP, a subjective signal). */
  warnings: z.array(z.string()),
  /** What a launch would refuse, as field → error key (the editor's own checks). */
  problems: z.record(z.string(), z.string()),
});
export type CopilotPlan = z.infer<typeof copilotPlanSchema>;
