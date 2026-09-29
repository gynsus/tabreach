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
  /** `human` when the user opens it; `automation` when a browser task does (docs/11). */
  controlMode: controlModeSchema.default('human'),
});
export const workerSetModeSchema = z.object({ sessionId: id, controlMode: controlModeSchema });
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

// Browser tasks (docs/07 "Browser tasks", Phase 5b) --------------------------------------------

/**
 * check_state: go to a page and say which pack state it is in (e.g. "is this profile signed in?").
 * commit: perform one critical pack action (docs/07 "Checkpoint rule", Phase 5c).
 */
export const browserTaskTypeSchema = z.enum(['check_state', 'commit']);

/**
 * auto: the worker presses the commit control after core acknowledges the checkpoint.
 * assisted: the worker prepares and waits for the person to press it (docs/07, ADR 015).
 */
export const browserExecutionModeSchema = z.enum(['auto', 'assisted']);
export type BrowserExecutionMode = z.infer<typeof browserExecutionModeSchema>;

export const workerTaskRunSchema = z
  .object({
    taskId: id,
    sessionId: id,
    taskType: browserTaskTypeSchema,
    /** The channel pack whose states are expected; generic challenge states always apply. */
    packId: z.string().min(1),
    url: z.url(),
    /** commit: the pack action, the values of its fields, and who presses the final control. */
    actionId: z.string().min(1).optional(),
    params: z.record(z.string(), z.string().max(20_000)).default({}),
    mode: browserExecutionModeSchema.default('auto'),
  })
  .refine((t) => t.taskType !== 'commit' || t.actionId !== undefined, {
    message: 'A commit task names its action',
    path: ['actionId'],
  });

/** Worker → core, before the irreversible press: core records "executing" first, then answers. */
export const taskCheckpointSchema = z.object({ taskId: id, phase: z.literal('about_to_commit') });
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;
/** proceed: false — do not press (paused, the intent changed); nothing has been sent. */
export const taskCheckpointAckSchema = z.object({ proceed: z.boolean() });

/** Failure evidence (docs/07 "Diagnostics"): never field values, never passwords. */
export const taskDiagnosticsSchema = z.object({
  title: z.string().nullable(),
  url: z.string().nullable(),
  /** File name of the screenshot in the diagnostics folder. */
  screenshot: z.string().nullable(),
  /** Accessibility snapshot with the values of inputs removed; truncated. */
  ariaSnapshot: z.string(),
  expectedStates: z.array(z.string()),
});
export type TaskDiagnostics = z.infer<typeof taskDiagnosticsSchema>;

/** Success is never implied by the absence of an error (docs/07). */
export const taskResultSchema = z.object({
  /** unknown: the commit control was pressed and the result could not be recognized. */
  status: z.enum(['succeeded', 'unsupported_state', 'needs_human', 'failed', 'unknown']),
  stateId: z.string().nullable(),
  stateKind: z.enum(['page', 'logged_in', 'login', 'challenge']).nullable(),
  packVersion: z.string(),
  url: z.string().nullable(),
  diagnostics: taskDiagnosticsSchema.nullable(),
  /** Translatable key for `failed` (`task.navigationFailed`, …). */
  errorKey: z.string().nullable(),
  /**
   * commit tasks: the commit control was pressed (or the person may have pressed it). A result
   * with `committed: false` guarantees nothing was sent.
   */
  committed: z.boolean().default(false),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

// Sign-in checks and interventions (Phase 5b) -------------------------------------------------

/** Channel packs whose sign-in a profile can be checked against. */
export const signInPackSchema = z.enum(['linkedin']);
export const profileCheckSignInSchema = z.object({ id, packId: signInPackSchema });

export const interventionReasonSchema = z.enum([
  'security_challenge',
  'login_required',
  'unsupported_state',
  /** The person took control, or paused from the page: the work waits until control is returned. */
  'user_control',
]);
export type InterventionReason = z.infer<typeof interventionReasonSchema>;

/** Something only the person can do (docs/11): solve a challenge, sign in, or look at a page. */
export const interventionSchema = z.object({
  id,
  reason: interventionReasonSchema,
  profileId: id.nullable(),
  profileName: z.string().nullable(),
  /** The Chrome window is still open to act in. */
  sessionOpen: z.boolean(),
  /** The recognized state (e.g. `generic.captcha.recaptcha`), when there was one. */
  stateId: z.string().nullable(),
  url: z.string().nullable(),
  diagnostics: taskDiagnosticsSchema.nullable(),
  requestedAt: z.iso.datetime(),
});
export type Intervention = z.infer<typeof interventionSchema>;

export const interventionResolveSchema = z.object({
  id,
  /** done: the person dealt with it, TabReach checks again. cancel: stop the work. */
  outcome: z.enum(['done', 'cancel']),
});

// Control (Phase 5c) ------------------------------------------------------------------------------

/** Worker → core: a session's control mode changed on the worker's side (overlay Pause, a challenge). */
export const sessionModeChangedSchema = z.object({
  sessionId: id,
  controlMode: controlModeSchema,
  by: z.enum(['overlay', 'challenge', 'emergency_stop']),
});
export type SessionModeChanged = z.infer<typeof sessionModeChangedSchema>;

/** What the overlay shows about the current work (docs/12): short labels, no secrets, no drafts. */
export const overlayContextSchema = z.object({
  title: z.string().max(200),
  detail: z.string().max(300).nullable(),
  /** The interface language, for the overlay's own labels. */
  lang: z.enum(['en', 'ru']),
});
export type OverlayContext = z.infer<typeof overlayContextSchema>;

/** App-wide control (docs/19 "Global pause and emergency stop", FR-BRA-008, FR-APP-004). */
export const appControlSchema = z.object({
  /** No new external action starts: sends and browser tasks wait; reading mail goes on. */
  paused: z.boolean(),
  /** Set by an emergency stop (which also pauses): everything in the browser was stopped. */
  emergencyStoppedAt: z.iso.datetime().nullable(),
  pausedAt: z.iso.datetime().nullable(),
  /** Keep the Mac awake while a campaign is active. */
  keepAwake: z.boolean(),
});
export type AppControl = z.infer<typeof appControlSchema>;
