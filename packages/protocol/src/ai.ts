import { z } from 'zod';

/** AI gateway settings and usage (docs/15). The API key itself never appears here. */

export const aiUseCaseSchema = z.enum(['classification', 'research', 'drafting']);
export type AiUseCase = z.infer<typeof aiUseCaseSchema>;

const model = z.string().trim().min(1).max(100);
const price = z.number().min(0).max(1_000);

export const aiSettingsInputSchema = z.object({
  provider: z.literal('anthropic'),
  /** Model per use case: a small one for classification, a stronger one for research and drafting. */
  models: z.object({ classification: model, research: model, drafting: model }),
  /** USD per million tokens, as the provider publishes them; without a price, cost is not estimated. */
  prices: z.record(model, z.object({ inputPerMTok: price, outputPerMTok: price })),
  /** Calls stop for the rest of the month once estimated spend reaches this; null = no budget. */
  monthlyBudgetUsd: z.number().min(0).max(100_000).nullable(),
});
export type AiSettingsInput = z.infer<typeof aiSettingsInputSchema>;

export const aiSettingsSchema = aiSettingsInputSchema.extend({
  /** Whether an API key is stored (encrypted). */
  keySet: z.boolean(),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettingsInput = {
  provider: 'anthropic',
  models: {
    classification: 'claude-haiku-4-5-20251001',
    research: 'claude-sonnet-5',
    drafting: 'claude-sonnet-5',
  },
  prices: {},
  monthlyBudgetUsd: null,
};

export const aiUsageSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  calls: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Null when a model used this month has no price set. */
  costUsd: z.number().nullable(),
  budgetUsd: z.number().nullable(),
  byUseCase: z.array(
    z.object({
      useCase: aiUseCaseSchema,
      calls: z.number().int().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type AiUsage = z.infer<typeof aiUsageSchema>;

/** How a reply was understood (docs/14 "Classification"). */
export const replyLabelSchema = z.enum(['interested', 'not_interested', 'opt_out', 'out_of_office', 'other']);
export type ReplyLabel = z.infer<typeof replyLabelSchema>;
