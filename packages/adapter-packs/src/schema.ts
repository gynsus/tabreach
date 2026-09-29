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

/** A frame (iframe) whose URL matches: how CAPTCHA widgets show themselves. Globs as for URLs. */
export const frameConditionSchema = z
  .object({
    frameUrlAny: z.array(nonEmpty).min(1),
  })
  .strict();

export const conditionSchema = z.union([roleConditionSchema, textConditionSchema, frameConditionSchema]);
export type Condition = z.infer<typeof conditionSchema>;

export const pageStateSchema = z
  .object({
    id: z
      .string()
      .regex(
        /^[a-z0-9_]+(\.[a-z0-9_]+)+$/,
        'State ids are dotted lowercase, e.g. linkedin.profile.connectable',
      ),
    /**
     * What a match means: an ordinary page of the flow, signed in, the site's sign-in page, or a
     * security challenge (CAPTCHA, code, unusual-login check) — which always goes to a person.
     */
    kind: z.enum(['page', 'logged_in', 'login', 'challenge']).default('page'),
    /** URL glob patterns; `*` matches any run of characters. https only; loopback http for fixtures. */
    url: z
      .array(
        z
          .string()
          .regex(/^(https:\/\/|http:\/\/127\.0\.0\.1[:/*])/, 'Only https URLs (or loopback fixtures)'),
      )
      .min(1),
    requires: z.array(conditionSchema).min(1, 'A state needs at least one positive condition'),
    forbids: z.array(conditionSchema).default([]),
  })
  .strict();
export type PageState = z.infer<typeof pageStateSchema>;

const stateId = z
  .string()
  .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'State ids are dotted lowercase, e.g. linkedin.profile.connectable');

/** A control found by role and accessible name (never by CSS or DOM position — docs/07). */
export const controlSchema = z
  .object({
    role: nonEmpty,
    nameAny: z.array(nonEmpty).min(1),
  })
  .strict();
export type Control = z.infer<typeof controlSchema>;

/**
 * A critical action (docs/07 "Checkpoint rule", Phase 5c): from a recognized state, fill the
 * named fields, stop at the checkpoint, press the commit control once, then recognize the result.
 * Only a `success` state counts as done; a `rejected` state is a verified "not sent"; anything
 * else after the press is `unknown`.
 */
export const packActionSchema = z
  .object({
    id: stateId,
    /** States the action may start from. */
    from: z.array(stateId).min(1),
    fill: z
      .array(z.object({ control: controlSchema, param: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) }).strict())
      .default([]),
    /** The control whose press is irreversible. */
    commit: controlSchema,
    success: z.array(stateId).min(1),
    /** The site refused before anything left (a validation error on the same form, say). */
    rejected: z.array(stateId).default([]),
  })
  .strict();
export type PackAction = z.infer<typeof packActionSchema>;

/** What a contact-form field means (docs/14 "Standard semantic fields"). */
export const FORM_FIELDS = [
  'name',
  'firstName',
  'lastName',
  'email',
  'phone',
  'company',
  'website',
  'subject',
  'message',
  'consent',
] as const;
export type FormField = (typeof FORM_FIELDS)[number];

const phrases = z.array(z.string().trim().toLowerCase().min(1)).min(1);

/**
 * Generic contact-form knowledge (docs/14 "Website form adapter", Phase 6): lower-case phrases
 * matched as substrings of a field's label, name, placeholder or autocomplete, of link texts, and
 * of what a page says after sending. Data, so it can be improved without code (ADR 017).
 */
export const formKnowledgeSchema = z
  .object({
    /** Link or button texts that lead to a contact form. */
    contactLinks: phrases,
    /** Paths worth trying when no link says "contact". */
    contactPaths: z.array(z.string().regex(/^\/[^\s]*$/)).default([]),
    fields: z
      .object(Object.fromEntries(FORM_FIELDS.map((f) => [f, phrases])) as Record<FormField, typeof phrases>)
      .strict(),
    /** Texts a site shows once a message was received. */
    success: phrases,
    /** Texts a site shows when it refused the form (validation). */
    rejected: phrases,
  })
  .strict();
export type FormKnowledge = z.infer<typeof formKnowledgeSchema>;

export const adapterPackSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Semantic version, e.g. 1.0.0'),
    /** generic: states for any site (challenges); the others belong to one channel adapter. */
    channel: z.enum(['generic', 'linkedin', 'web_form']),
    states: z.array(pageStateSchema).default([]),
    actions: z.array(packActionSchema).default([]),
    forms: formKnowledgeSchema.optional(),
  })
  .strict()
  .superRefine((pack, ctx) => {
    if (pack.states.length === 0 && !pack.forms) {
      ctx.addIssue({ code: 'custom', path: ['states'], message: 'A pack needs states or form knowledge' });
    }
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
    const actions = new Set<string>();
    pack.actions.forEach((action, i) => {
      if (actions.has(action.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'id'],
          message: `Duplicate action id ${action.id}`,
        });
      }
      actions.add(action.id);
      for (const key of ['from', 'success', 'rejected'] as const) {
        action[key].forEach((ref, j) => {
          if (!seen.has(ref)) {
            ctx.addIssue({ code: 'custom', path: ['actions', i, key, j], message: `Unknown state ${ref}` });
          }
        });
      }
    });
  });
export type AdapterPack = z.infer<typeof adapterPackSchema>;

export function parseAdapterPack(data: unknown): AdapterPack {
  return adapterPackSchema.parse(data);
}
