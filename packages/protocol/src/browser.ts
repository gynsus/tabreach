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
  /** No window (the research profile, docs/16): nobody watches it, so it gets no overlay either. */
  headless: z.boolean().default(false),
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

/** The person a profile page must show: its profile URL and name. */
export const targetIdentitySchema = z.object({
  profileUrl: z.url(),
  name: z.string().trim().min(1).max(300),
});
export type TargetIdentity = z.infer<typeof targetIdentitySchema>;

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
    /** Who the page must be about (FR-LIN-003): checked before any click, and again at the checkpoint. */
    identity: targetIdentitySchema.optional(),
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

/**
 * Reads a conversation with a pack reader (FR-LIN-004): whether the person answered after our last
 * message. Only directions are read, never the text of messages.
 */
export const workerThreadReadSchema = z.object({
  taskId: id,
  sessionId: id,
  packId: z.string().min(1),
  url: z.url(),
  readerId: z.string().min(1),
  identity: targetIdentitySchema,
});
export const threadReadResultSchema = z.object({
  status: z.enum(['ok', 'unsupported_state', 'needs_human', 'failed']),
  /** Oldest first. */
  messages: z.array(z.object({ direction: z.enum(['in', 'out']) })).max(500),
  /** An inbound message after our last one (or they wrote first). */
  replied: z.boolean(),
  stateId: z.string().nullable(),
  packVersion: z.string(),
  errorKey: z.string().nullable(),
  diagnostics: taskDiagnosticsSchema.nullable(),
});
export type ThreadReadResult = z.infer<typeof threadReadResultSchema>;

// Research rendering (docs/16, Phase 5d) -------------------------------------------------------

/**
 * RenderPageForResearch: open a page of the company's site in the research profile and return its
 * rendered HTML. The page stays on `site`; no request reaches a non-public address.
 */
export const workerRenderSchema = z.object({
  taskId: id,
  sessionId: id,
  url: z.url(),
  /** The company's site host: the page may not navigate away from it. */
  site: z.string().min(1),
});
export const renderResultSchema = z.object({
  /** challenge: a CAPTCHA or check stood in the way (never solved — the page is skipped). */
  status: z.enum(['ok', 'challenge', 'blocked', 'failed']),
  url: z.string().nullable(),
  title: z.string().nullable(),
  /** The rendered document, at most 2 MB; null unless ok. */
  html: z
    .string()
    .max(2 * 1024 * 1024)
    .nullable(),
  /** Why not ok: `offsite`, `blocked_address`, `navigation`, a challenge state id, … */
  reason: z.string().nullable(),
});
export type RenderResult = z.infer<typeof renderResultSchema>;

// Website forms (docs/14 "Website form adapter", Phase 6) ------------------------------------------

/** What a form field means (docs/14 "Standard semantic fields"); the same list as the web-form pack. */
export const formFieldMeaningSchema = z.enum([
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
]);
export type FormFieldMeaning = z.infer<typeof formFieldMeaningSchema>;

const formValue = z.string().max(20_000).optional();
/** What TabReach may write into a form: the sender's details and the message. Never a consent. */
export const formValuesSchema = z.object({
  name: formValue,
  firstName: formValue,
  lastName: formValue,
  email: formValue,
  phone: formValue,
  company: formValue,
  website: formValue,
  subject: formValue,
  message: formValue,
});
export type FormValues = z.infer<typeof formValuesSchema>;

export const formFieldSchema = z.object({
  /** Position among the form's elements: how the same field is found again. */
  ref: z.number().int().min(0),
  kind: z.enum(['text', 'email', 'tel', 'url', 'textarea', 'select', 'checkbox', 'radio', 'other']),
  /** What the page calls it (label, aria-label or placeholder). */
  label: z.string().max(300),
  required: z.boolean(),
  meaning: formFieldMeaningSchema.nullable(),
  /** How the meaning was found: the pack's phrases, or AI choosing from the closed list (Phase 6c). */
  source: z.enum(['pack', 'ai']).nullable().default(null),
  /** What TabReach writes there; null: left as the page has it (a consent is never ticked). */
  value: z.string().max(20_000).nullable(),
  /** Check boxes and radios as the page left them; a consent ticked by the page is unticked. */
  checked: z.boolean().default(false),
  /** Text the page already put in a field TabReach leaves alone (it is sent as it is). */
  prefilled: z.string().max(500).nullable().default(null),
});
export type FormField = z.infer<typeof formFieldSchema>;

/** PrepareFormSubmission: find the contact form from a website, map and fill it, stop before sending. */
export const workerFormPrepareSchema = z.object({
  taskId: id,
  sessionId: id,
  packId: z.string().min(1).default('web-form'),
  /** The company's website, or a known form page. */
  url: z.url(),
  values: formValuesSchema,
});

export const formPrepareResultSchema = z.object({
  /**
   * ready: every required field has a value. needs_human: a required field TabReach cannot fill,
   * a required consent, or a challenge. no_form: no contact form found on the site.
   */
  status: z.enum(['ready', 'needs_human', 'no_form', 'failed']),
  /** `form.unmappedRequired`, `form.consentRequired`, `form.challenge`, `form.notFound`, `task.*`. */
  reason: z.string().nullable(),
  formUrl: z.string().nullable(),
  /** The button that opens the form in a dialog, when it is not on its own page. */
  opener: z.string().max(200).nullable(),
  /** Hash of the form's fields: sending refuses a form that changed since it was approved. */
  signature: z.string().nullable(),
  fields: z.array(formFieldSchema),
  /** A CAPTCHA or check on the form page: never solved; the person sends it. */
  challenge: z.string().nullable(),
  /** PNG of the form as the site shows it, base64; nothing is typed in before approval. */
  screenshot: z.string().max(4_000_000).nullable(),
  /** Where the form sends (origin and path of its action). */
  action: z.string().max(2_000).nullable().default(null),
  packVersion: z.string(),
});
export type FormPrepareResult = z.infer<typeof formPrepareResultSchema>;

/**
 * Bounded semantic resolution (ADR 013, Phase 6c), worker → core: AI chooses from a closed list —
 * a meaning for each field the pack's phrases did not recognize, or one link that leads to the
 * contact form. Page text is untrusted data; the answer is checked against the list. Never used for
 * the button that sends.
 */
const candidateText = z.string().max(300);
export const resolveTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('form_fields'),
    taskId: id,
    fields: z
      .array(
        z.object({
          ref: z.number().int().min(0),
          label: candidateText,
          placeholder: candidateText,
          name: candidateText,
          type: z.string().max(30),
        }),
      )
      .min(1)
      .max(30),
  }),
  z.object({
    kind: z.literal('contact_link'),
    taskId: id,
    /** The site's own links: text and path. */
    links: z
      .array(z.object({ ref: z.number().int().min(0), text: candidateText, path: candidateText }))
      .min(1)
      .max(40),
  }),
]);
export type ResolveTargetRequest = z.infer<typeof resolveTargetSchema>;
export const resolveTargetResultSchema = z.object({
  /** false: no AI key, over budget, or the provider failed — the worker goes on without it. */
  available: z.boolean(),
  /** form_fields: a meaning (never a consent) or null per field ref. */
  meanings: z
    .array(
      z.object({
        ref: z.number().int().min(0),
        meaning: formFieldMeaningSchema.exclude(['consent']).nullable(),
      }),
    )
    .default([]),
  /** contact_link: the chosen link's ref, or null. */
  link: z.number().int().min(0).nullable().default(null),
});
export type ResolveTargetResult = z.infer<typeof resolveTargetResultSchema>;

/** ExecuteFormSubmission: the approved fields into the same form, checkpoint, send, verify. */
export const workerFormSubmitSchema = z.object({
  taskId: id,
  sessionId: id,
  packId: z.string().min(1).default('web-form'),
  formUrl: z.url(),
  opener: z.string().max(200).nullable(),
  signature: z.string().min(1),
  fields: z.array(z.object({ ref: z.number().int().min(0), value: z.string().max(20_000) })).max(50),
  mode: browserExecutionModeSchema.default('auto'),
});

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

// Adapter pack health (Phase 7c, FR-LIN-006) ----------------------------------------------------

/** How a pack version fares on real pages: an unrecognized page means the pack needs updating. */
export const packHealthSchema = z.object({
  packId: z.string(),
  version: z.string(),
  /** Browser tasks with this pack version in the last 30 days. */
  tasks: z.number().int(),
  unsupported: z.number().int(),
  needsHuman: z.number().int(),
  unknown: z.number().int(),
  lastUnsupportedAt: z.iso.datetime().nullable(),
});
export type PackHealth = z.infer<typeof packHealthSchema>;
