import { z } from 'zod';

/**
 * Adapter pack format (ADR 017, docs/07-BROWSER-RUNTIME.md). Packs are data only: page states
 * described by positive conditions. Adapters act only when a state matches (allowlist).
 *
 * Phase 0 ships the schema for page states; locators, verification rules and limits are added
 * with the adapters that need them (Phases 5–7).
 */
const nonEmpty = z.string().min(1);

export const roleConditionSchema = z
  .object({
    role: nonEmpty,
    name: nonEmpty.optional(),
    /** Any of these accessible names; lists UI-language variants. */
    nameAny: z.array(nonEmpty).min(1).optional(),
    level: z.number().int().min(1).max(6).optional(),
  })
  .strict()
  .refine((c) => !(c.name && c.nameAny), { message: 'Use either name or nameAny, not both' });

export const textConditionSchema = z
  .object({
    textAny: z.array(nonEmpty).min(1),
  })
  .strict();

export const conditionSchema = z.union([roleConditionSchema, textConditionSchema]);
export type Condition = z.infer<typeof conditionSchema>;

export const pageStateSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9_]+(\.[a-z0-9_]+)+$/,
        'State ids are dotted lowercase, e.g. linkedin.profile.connectable',
      ),
    /** URL glob patterns; `*` matches any run of characters. */
    url: z.array(z.string().regex(/^https:\/\//, 'Only https URLs')).min(1),
    requires: z.array(conditionSchema).min(1, 'A state needs at least one positive condition'),
    forbids: z.array(conditionSchema).default([]),
  })
  .strict();
export type PageState = z.infer<typeof pageStateSchema>;

export const adapterPackSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Semantic version, e.g. 1.0.0'),
    channel: z.enum(['linkedin', 'web_form']),
    states: z.array(pageStateSchema).min(1),
  })
  .strict()
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    pack.states.forEach((state, i) => {
      if (seen.has(state.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['states', i, 'id'],
          message: `Duplicate state id ${state.id}`,
        });
      }
      seen.add(state.id);
    });
  });
export type AdapterPack = z.infer<typeof adapterPackSchema>;

export function parseAdapterPack(data: unknown): AdapterPack {
  return adapterPackSchema.parse(data);
}
