import { z } from 'zod';

/** A screenshot the worker kept for an unrecognized page (masked, docs/07 "Diagnostics"). */
export const diagnosticsFileSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}\.png$/, 'A diagnostics screenshot name');

export const diagnosticScreenshotSchema = z.object({
  file: diagnosticsFileSchema,
  takenAt: z.iso.datetime(),
  packId: z.string().nullable(),
  /** The state the page was expected in, or the one it was in; codes only. */
  stateId: z.string().nullable(),
  errorKey: z.string().nullable(),
});
export type DiagnosticScreenshot = z.infer<typeof diagnosticScreenshotSchema>;

export const diagnosticsBundleRequestSchema = z.object({
  /** Screenshots the person chose to include; none by default (docs/20 "Diagnostics bundle"). */
  screenshots: z.array(diagnosticsFileSchema).max(20).default([]),
});

export const diagnosticsBundleSchema = z.object({
  filename: z.string(),
  /** The zip, base64-encoded: the renderer hands it to main to save where the person chooses. */
  base64: z.string(),
  bytes: z.number().int().nonnegative(),
  /** What went in, for the person to see before sending it anywhere. */
  contents: z.array(z.string()),
});
export type DiagnosticsBundle = z.infer<typeof diagnosticsBundleSchema>;
