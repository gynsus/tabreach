import { z } from 'zod';

/** Email accounts TabReach sends from (docs/14, ADR 016). Secrets never appear in these DTOs. */

export const mailSecuritySchema = z.enum(['tls', 'starttls']);
export type MailSecurity = z.infer<typeof mailSecuritySchema>;

const host = z.string().trim().min(1).max(255);
const port = z.number().int().min(1).max(65_535);

export const mailServerSchema = z.object({ host, port, security: mailSecuritySchema });
export type MailServer = z.infer<typeof mailServerSchema>;

export const accountLimitsSchema = z.object({
  /** Most messages in any 24 hours. */
  dailyLimit: z.number().int().min(1).max(2_000),
  /** Minimum time between two messages. */
  minSpacingSeconds: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60),
});
export type AccountLimits = z.infer<typeof accountLimitsSchema>;

export const DEFAULT_EMAIL_LIMITS: AccountLimits = { dailyLimit: 50, minSpacingSeconds: 60 };

export const accountStatusSchema = z.enum(['active', 'auth_required', 'disabled']);
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const emailAccountSchema = z.object({
  id: z.uuid(),
  provider: z.enum(['imap_smtp', 'gmail_api']),
  address: z.string(),
  displayName: z.string(),
  /** Name shown to recipients ("Ann Lee" <ann@…>). */
  fromName: z.string().nullable(),
  status: accountStatusSchema,
  limits: accountLimitsSchema,
  smtp: mailServerSchema.nullable(),
  imap: mailServerSchema.nullable(),
  username: z.string().nullable(),
  /** Whether TabReach copies sent mail to the Sent folder itself (the server does not). */
  appendToSent: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type EmailAccount = z.infer<typeof emailAccountSchema>;

export const imapAccountInputSchema = z.object({
  address: z.string().trim().min(3).max(320),
  displayName: z.string().trim().max(200).optional(),
  fromName: z.string().trim().max(200).nullish(),
  smtp: mailServerSchema,
  imap: mailServerSchema,
  username: z.string().trim().min(1).max(320),
  /** App password or account password; stored encrypted, never returned. */
  password: z.string().min(1).max(1_000),
  /** Null: decide from the provider (Gmail and Outlook save sent mail themselves). */
  appendToSent: z.boolean().nullable().default(null),
  limits: accountLimitsSchema.optional(),
});
export type ImapAccountInput = z.infer<typeof imapAccountInputSchema>;

export const accountUpdateSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1).max(200).optional(),
  fromName: z.string().trim().max(200).nullish(),
  limits: accountLimitsSchema.optional(),
  /** A new password replaces the stored one after a successful connection test. */
  password: z.string().min(1).max(1_000).optional(),
});

export const connectionCheckSchema = z.object({
  smtp: z.object({ ok: z.boolean(), error: z.string().optional() }),
  imap: z.object({ ok: z.boolean(), error: z.string().optional(), sentFolder: z.string().nullable() }),
});
export type ConnectionCheck = z.infer<typeof connectionCheckSchema>;
