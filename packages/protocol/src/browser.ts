import { z } from 'zod';

/** Browser profiles and sessions (docs/08, docs/11, Phase 5a). */

const id = z.uuid();

/** channel_identity: one channel account (Phase 7). research: rendering research pages. general: anything else. */
export const profilePurposeSchema = z.enum(['general', 'research', 'channel_identity']);
export type ProfilePurpose = z.infer<typeof profilePurposeSchema>;

/** Lifecycle (docs/08): ready ↔ open, plus what a health check found. */
export const profileStatusSchema = z.enum(['ready', 'open', 'needs_login', 'unhealthy', 'archived']);
export type ProfileStatus = z.infer<typeof profileStatusSchema>;

/** Who drives a session (docs/11): automation may act only in `automation`. */
export const controlModeSchema = z.enum(['automation', 'paused', 'human']);
export type ControlMode = z.infer<typeof controlModeSchema>;

export const sessionStatusSchema = z.enum(['opening', 'open', 'closed', 'interrupted']);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const profileHealthStatusSchema = z.enum([
  'healthy',
  'needs_login',
  'needs_human',
  'busy',
  'unhealthy',
  'unknown',
]);
export type ProfileHealthStatus = z.infer<typeof profileHealthStatusSchema>;

export const browserChannelSchema = z.enum(['chrome', 'chromium']);

export const browserSessionSchema = z.object({
  id,
  controlMode: controlModeSchema,
  status: sessionStatusSchema,
  currentUrl: z.string().nullable(),
  startedAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime().nullable(),
});
export type BrowserSession = z.infer<typeof browserSessionSchema>;

export const browserProfileSchema = z.object({
  id,
  name: z.string(),
  purpose: profilePurposeSchema,
  status: profileStatusSchema,
  browserChannel: browserChannelSchema,
  /** The running session, if the profile is open. */
  session: browserSessionSchema.nullable(),
  health: z
    .object({
      status: profileHealthStatusSchema,
      /** A translatable key (`profile.locked`, `chrome.missing`, …). */
      detail: z.string().nullable(),
      checkedAt: z.iso.datetime(),
    })
    .nullable(),
  lastOpenedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type BrowserProfile = z.infer<typeof browserProfileSchema>;

const name = z.string().trim().min(1).max(100);

export const profileCreateSchema = z.object({
  name,
  /** channel_identity profiles are created with their channel account (Phase 7). */
  purpose: z.enum(['general', 'research']),
});
export const profileUpdateSchema = z.object({ id, name });
/** Deleting destroys the signed-in browser state: the user types the profile's name (docs/08). */
export const profileDeleteSchema = z.object({ id, confirmName: z.string() });

// core ↔ worker (docs/07 "Browser protocol") --------------------------------------------------

export const workerProfileOpenSchema = z.object({
  profileId: id,
  sessionId: id,
  channel: browserChannelSchema,
  /** A page to show first, e.g. a site to sign in to. */
  startUrl: z.url().nullable(),
});
export const workerProfileOpenResultSchema = z.object({
  chromeVersion: z.string().nullable(),
  currentUrl: z.string().nullable(),
});
export const workerSessionRefSchema = z.object({ sessionId: id });
export const workerProfileRefSchema = z.object({ profileId: id });
export const workerProfileHealthSchema = z.object({
  status: profileHealthStatusSchema,
  detail: z.string().nullable(),
});
export type WorkerProfileHealth = z.infer<typeof workerProfileHealthSchema>;

/** Worker → core: a session opened, was closed (by the user or by core) or crashed. */
export const sessionChangedSchema = z.object({
  sessionId: id,
  profileId: id,
  status: z.enum(['open', 'closed', 'crashed']),
  currentUrl: z.string().nullable(),
});
export type SessionChanged = z.infer<typeof sessionChangedSchema>;

/** Worker → core, every few seconds: which sessions are alive and where they are. */
export const workerHeartbeatSchema = z.object({
  sessions: z.array(z.object({ sessionId: id, currentUrl: z.string().nullable() })),
});
