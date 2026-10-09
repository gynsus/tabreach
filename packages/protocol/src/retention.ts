import { z } from 'zod';

/** Days to keep, or null to keep for as long as the record exists. */
const keepDays = z.number().int().min(1).max(3650).nullable();

/**
 * How long each kind of sensitive data is kept (docs/18 "Data retention"). Enforced by a daily
 * core job; audit events are kept (append-only, and they carry no personal data — ADR 022), and
 * AI raw responses are never stored.
 */
export const retentionSettingsSchema = z.object({
  /** Screenshots of pages and prepared forms. */
  screenshots: keepDays.default(30),
  /** Page titles, addresses and accessibility snapshots kept with browser tasks. */
  browserDiagnostics: keepDays.default(30),
  /** Texts of drafts, of forms filled in, and of email messages — once their step is over. */
  messageBodies: keepDays.default(null),
  /** Page text captured as research evidence (the facts and their quotes stay). */
  researchEvidence: keepDays.default(180),
  /** Older log files (the current ones are rotated by size). */
  logs: keepDays.default(30),
});
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export const RETENTION_DEFAULTS: RetentionSettings = retentionSettingsSchema.parse({});

/** What one pass removed, per kind: counts only. */
export const retentionReportSchema = z.object({
  ranAt: z.iso.datetime(),
  screenshots: z.number().int().nonnegative(),
  browserDiagnostics: z.number().int().nonnegative(),
  messageBodies: z.number().int().nonnegative(),
  researchEvidence: z.number().int().nonnegative(),
  logs: z.number().int().nonnegative(),
});
export type RetentionReport = z.infer<typeof retentionReportSchema>;

export const retentionStateSchema = z.object({
  settings: retentionSettingsSchema,
  lastRun: retentionReportSchema.nullable(),
});
