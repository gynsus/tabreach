import { z } from 'zod';
import { browserExecutionModeSchema, formFieldSchema, stepExecutionModeSchema } from './browser.js';

/** DTOs for campaigns, enrollments, approvals, contact policy and jobs (docs/06, docs/17, ADR 021). */

const id = z.uuid();
const text = (max: number) => z.string().trim().max(max);

// Schedule ----------------------------------------------------------------------------------

const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time.invalid');

/** Days are ISO weekdays: 1 = Monday … 7 = Sunday. Times are wall-clock in the recipient's zone. */
export const activeWindowSchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    start: clockTime,
    end: clockTime,
  })
  .refine((w) => w.start < w.end, { message: 'window.endBeforeStart', path: ['end'] });
export type ActiveWindow = z.infer<typeof activeWindowSchema>;

// Contact policy (ADR 021 §6) ---------------------------------------------------------------

const capSchema = z.object({
  touches: z.number().int().min(1).max(100),
  days: z.number().int().min(1).max(365),
});

export const policySettingsSchema = z.object({
  contactCap: capSchema,
  companyCap: capSchema,
  companyStopOnReply: z.boolean(),
  window: activeWindowSchema,
});
export type PolicySettings = z.infer<typeof policySettingsSchema>;

export const DEFAULT_POLICY: PolicySettings = {
  contactCap: { touches: 1, days: 3 },
  companyCap: { touches: 3, days: 7 },
  companyStopOnReply: true,
  window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
};

// Campaign configuration --------------------------------------------------------------------

/** Placeholders a template may use: `{{firstName}}` or `{{firstName|there}}` (with a default). */
export const templateFields = [
  'firstName',
  'lastName',
  'fullName',
  'jobTitle',
  'companyName',
  'companyCity',
  'companyCountry',
] as const;
export type TemplateField = (typeof templateFields)[number];

/**
 * Channels a message step can use: email (through the campaign's email account), a company's
 * website contact form (through the form sender's browser profile, Phase 6) or the local test channel.
 */
export const messageChannelSchema = z.enum(['email', 'test', 'web_form', 'linkedin']);

/** A LinkedIn step invites (with the message as its note, if any) or writes to a connection. */
export const linkedinActionSchema = z.enum(['connect', 'message']);
export type LinkedinAction = z.infer<typeof linkedinActionSchema>;

/** Fields a condition step can test (ADR 021 §7). */
export const conditionFieldSchema = z.enum([
  'contact.firstName',
  'contact.lastName',
  'contact.jobTitle',
  'contact.email',
  'contact.tags',
  'company.name',
  'company.domain',
  'company.country',
  'company.city',
  'company.tags',
]);
export const conditionOpSchema = z.enum(['eq', 'neq', 'exists', 'not_exists', 'contains']);
export const conditionSchema = z.object({
  field: conditionFieldSchema,
  op: conditionOpSchema,
  value: text(200).optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

const MAX_DELAY_SECONDS = 365 * 24 * 60 * 60;
const delaySeconds = z.number().int().min(0).max(MAX_DELAY_SECONDS);

export const sendMessageStepSchema = z.object({
  type: z.literal('send_message'),
  channel: messageChannelSchema,
  /**
   * Website forms: `auto` sends after approval; `assisted` fills the form and the person presses
   * Send (docs/01 "Execution modes"). Email and the test channel are always `auto`.
   */
  executionMode: stepExecutionModeSchema.default('auto'),
  delaySeconds,
  /** template: subject and body with placeholders. ai: written per recipient from research facts. */
  mode: z.enum(['template', 'ai']).default('template'),
  subject: text(300),
  body: z.string().max(20_000),
  /** AI steps: what the message should say and do (tone, offer, call to action, language). */
  instructions: z.string().max(4_000).default(''),
  /** Appended as written, never by the model. */
  signature: z.string().max(1_000).default(''),
  /** LinkedIn steps (Phase 7): send an invitation or a message. */
  linkedinAction: linkedinActionSchema.default('message'),
});

export const conditionStepSchema = z.object({
  type: z.literal('condition'),
  delaySeconds,
  conditions: z.array(conditionSchema).min(1).max(10),
  /** When a condition does not hold: stop the enrollment, or skip the next step and continue after it. */
  onFalse: z.enum(['stop', 'skip']),
});

export const stepSchema = z.discriminatedUnion('type', [sendMessageStepSchema, conditionStepSchema]);
export type CampaignStep = z.infer<typeof stepSchema>;

export const campaignConfigSchema = z.object({
  steps: z.array(stepSchema).max(20),
  /** Fallback when neither contact nor company has a timezone; null = the Mac's zone. */
  timezone: z.string().max(100).nullable(),
  /** Overrides the policy's default active window. */
  window: activeWindowSchema.nullable(),
  /**
   * approve_each: every message waits for a person. approve_campaign: after `sampleSize` approved by
   * hand, AI drafts that pass every check are approved automatically (docs/17).
   */
  approvalMode: z.enum(['approve_each', 'approve_campaign']).default('approve_each'),
  sampleSize: z.number().int().min(1).max(50).default(5),
  /** Draft checks (docs/17 "approve_campaign"). */
  maxLength: z.number().int().min(100).max(10_000).default(1_500),
  forbiddenPhrases: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  /** Domains links in a message may point to; empty: no links. */
  allowedLinkDomains: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  /** The email account email steps send from (required when the campaign has email steps). */
  emailAccountId: z.uuid().nullable().default(null),
});
export type CampaignConfig = z.infer<typeof campaignConfigSchema>;
/** A config as written by a caller: fields with defaults may be left out. */
export type CampaignConfigInput = z.input<typeof campaignConfigSchema>;

export const EMPTY_CAMPAIGN_CONFIG: CampaignConfig = {
  steps: [],
  timezone: null,
  window: null,
  approvalMode: 'approve_each',
  sampleSize: 5,
  maxLength: 1_500,
  forbiddenPhrases: [],
  allowedLinkDomains: [],
  emailAccountId: null,
};

// Campaigns ---------------------------------------------------------------------------------

export const campaignStatusSchema = z.enum(['draft', 'active', 'paused', 'archived']);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

export const enrollmentStatusSchema = z.enum(['active', 'paused', 'completed', 'stopped']);
export type EnrollmentStatus = z.infer<typeof enrollmentStatusSchema>;

export const campaignSchema = z.object({
  id,
  name: z.string(),
  status: campaignStatusSchema,
  config: campaignConfigSchema,
  activeVersion: z.number().int().nullable(),
  enrollments: z.record(enrollmentStatusSchema, z.number().int().nonnegative()),
  pendingApprovals: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Campaign = z.infer<typeof campaignSchema>;

export const campaignCreateSchema = z.object({
  name: text(200).min(1),
  config: campaignConfigSchema.optional(),
});
export const campaignUpdateSchema = z.object({
  id,
  name: text(200).min(1).optional(),
  config: campaignConfigSchema.optional(),
});

/** A copy of the campaign's current draft, as a new draft: no versions, no people (FR-CAM-001). */
export const campaignCloneSchema = z.object({ id, name: text(200).min(1) });

export const enrollRequestSchema = z.object({
  campaignId: id,
  contactIds: z.array(id).min(1).max(5_000),
});
export const enrollReportSchema = z.object({
  enrolled: z.number().int().nonnegative(),
  alreadyEnrolled: z.number().int().nonnegative(),
  /** Archived or missing contacts. */
  skipped: z.number().int().nonnegative(),
  /** Contacts who (or whose company) replied: not contacted again until allowed. */
  onHold: z.number().int().nonnegative(),
});
export type EnrollReport = z.infer<typeof enrollReportSchema>;

export const stopReasonSchema = z.enum([
  'manual',
  'campaign_archived',
  'suppressed',
  'invalid_target',
  'missing_data',
  'condition_not_met',
  'rejected',
  'send_failed',
  'replied',
  'company_replied',
  'bounced',
  /** AI could not write the message (no key, budget, provider refusal, invalid answers). */
  'draft_failed',
  /** No contact form on the company's website (Phase 6). */
  'no_contact_form',
  /** LinkedIn: the invitation was not accepted in time, so the message could not be sent (Phase 7). */
  'not_connected',
  /**
   * LinkedIn: before the campaign wrote to them, the person's message was the last in the thread.
   * Not a reply to the campaign; it does not write over an unanswered message (Phase 7).
   */
  'unanswered_message',
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const enrollmentSchema = z.object({
  id,
  campaignId: id,
  contactId: id,
  contactName: z.string(),
  email: z.string().nullable(),
  version: z.number().int(),
  status: enrollmentStatusSchema,
  stepPosition: z.number().int(),
  stepCount: z.number().int(),
  nextActionAt: z.iso.datetime().nullable(),
  stopReason: stopReasonSchema.nullable(),
  /** What the current step is waiting for, if anything. */
  waiting: z.enum(['approval', 'schedule', 'retry', 'draft']).nullable(),
  updatedAt: z.iso.datetime(),
});
export type Enrollment = z.infer<typeof enrollmentSchema>;

export const enrollmentListRequestSchema = z.object({
  campaignId: id,
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

// Approvals ---------------------------------------------------------------------------------

/** Who wrote a draft version: the step's template, AI, or a person editing it. */
export const draftOriginSchema = z.enum(['template', 'ai', 'user']);
export type DraftOrigin = z.infer<typeof draftOriginSchema>;

/** Automated draft checks (docs/17 "approve_campaign", ADR 025). */
export const draftCheckKeySchema = z.enum([
  'grounding',
  'length',
  'forbidden_phrases',
  'links',
  'signature',
  'target',
]);
export type DraftCheckKey = z.infer<typeof draftCheckKeySchema>;
export const draftCheckSchema = z.object({
  key: draftCheckKeySchema,
  passed: z.boolean(),
  /** What failed, as the user can act on it: unsupported specifics, the phrase, the link. */
  detail: z.string().nullable(),
});
export type DraftCheck = z.infer<typeof draftCheckSchema>;

export const draftFactSchema = z.object({
  id: z.uuid(),
  claim: z.string(),
  quote: z.string(),
  url: z.string().nullable(),
});
export type DraftFact = z.infer<typeof draftFactSchema>;

// Dry run (FR-CAM-008, docs/17 "Launch validation") ------------------------------------------

export const campaignPreviewRequestSchema = z.object({
  campaignId: id,
  contactId: id,
  /** AI steps: write the message now (one AI call, research first if the company has none). */
  generate: z.boolean().default(false),
});

/** The message of the first action. AI content is written only when asked for. */
export const previewContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('template'), subject: z.string().nullable(), body: z.string() }),
  z.object({ kind: z.literal('ai_not_generated') }),
  z.object({
    kind: z.literal('ai'),
    subject: z.string().nullable(),
    body: z.string(),
    facts: z.array(draftFactSchema.omit({ id: true })),
  }),
  /** The company's research is running; asked again, the message is written from it. */
  z.object({ kind: z.literal('ai_research_running') }),
  z.object({ kind: z.literal('ai_failed'), reason: z.string() }),
]);
export type PreviewContent = z.infer<typeof previewContentSchema>;

export const campaignPreviewSchema = z.object({
  contactName: z.string(),
  /** Condition steps walked through before the first action. */
  conditions: z.array(
    z.object({ position: z.number().int(), holds: z.boolean(), onFalse: z.enum(['stop', 'skip']) }),
  ),
  /** The contact is already in this campaign: enrolling again does nothing. */
  alreadyEnrolled: z.boolean(),
  outcome: z.discriminatedUnion('kind', [
    /** No message step is reached (no steps, or every one skipped). */
    z.object({ kind: z.literal('none') }),
    /** The contact would be stopped before anything goes out. */
    z.object({
      kind: z.literal('stopped'),
      position: z.number().int().nullable(),
      reason: stopReasonSchema,
      rule: z.string().nullable(),
      fields: z.array(z.string()),
    }),
    z.object({
      kind: z.literal('action'),
      position: z.number().int(),
      channel: messageChannelSchema,
      linkedinAction: linkedinActionSchema.nullable(),
      executionMode: stepExecutionModeSchema,
      /** Email address, LinkedIn profile or website the action goes to. */
      target: z.string(),
      /** The earliest moment it may go: delays, the recipient's active window and frequency caps. */
      plannedAt: z.iso.datetime(),
      timeZone: z.string(),
      /** A frequency cap that moves it later, if any (`cap.contact`, `cap.company`). */
      deferredBy: z.string().nullable(),
      content: previewContentSchema,
    }),
  ]),
});
export type CampaignPreview = z.infer<typeof campaignPreviewSchema>;

/** The prepared form an approval covers (Phase 6). */
export const approvalFormSchema = z.object({
  formUrl: z.string(),
  fields: z.array(formFieldSchema),
  /** assisted: the person presses Send (always when a field, a consent or a CAPTCHA needs them). */
  mode: browserExecutionModeSchema,
  /** Why the person is needed: `form.unmappedRequired`, `form.consentRequired`, `form.challenge`. */
  reason: z.string().nullable(),
  hasScreenshot: z.boolean(),
  /** Where the form sends; `crossSite` when that is not the company's own site. */
  action: z.string().nullable().default(null),
  crossSite: z.boolean().default(false),
});
export type ApprovalForm = z.infer<typeof approvalFormSchema>;

export const approvalSchema = z.object({
  id,
  campaignId: id,
  campaignName: z.string(),
  enrollmentId: id,
  contactId: id,
  contactName: z.string(),
  target: z.string(),
  channel: z.string(),
  stepPosition: z.number().int(),
  draftId: id,
  draftVersion: z.number().int(),
  subject: z.string().nullable(),
  body: z.string(),
  contentHash: z.string(),
  origin: draftOriginSchema,
  /** Results of the draft checks for exactly this content. */
  checks: z.array(draftCheckSchema),
  /** The research facts the draft says it used, with their quotes and sources. */
  facts: z.array(draftFactSchema),
  /** Website forms: exactly what goes into the form (FR-FRM-003); null for other channels. */
  form: approvalFormSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type Approval = z.infer<typeof approvalSchema>;

export const approvalDecisionSchema = z.object({ approvalId: id });
export const approveRequestSchema = approvalDecisionSchema.extend({
  /** The hash the user saw; must still match the current draft (APPROVAL_STALE otherwise). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export const draftReviseSchema = z.object({
  draftId: id,
  subject: text(300),
  body: z.string().max(20_000),
});

// Jobs --------------------------------------------------------------------------------------

export const jobSchema = z.object({
  id,
  type: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'dead']),
  attempts: z.number().int(),
  lastErrorClass: z.string().nullable(),
  lastError: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type Job = z.infer<typeof jobSchema>;

/** A send whose outcome TabReach could not verify; a person settles it (ADR 018 user_confirmation). */
export const uncertainSendSchema = z.object({
  id: z.uuid(),
  channel: z.string(),
  target: z.string(),
  contactId: z.uuid().nullable(),
  contactName: z.string(),
  campaignName: z.string().nullable(),
  /** A campaign step, or a reply the user sent from the inbox (ADR 031). */
  source: z.enum(['campaign', 'reply']),
  attemptedAt: z.iso.datetime(),
  /** TabReach is still checking on its own (a job will look again); deciding now is refused. */
  checking: z.boolean(),
});
export type UncertainSend = z.infer<typeof uncertainSendSchema>;

export const draftVersionSchema = z.object({
  id: z.uuid(),
  version: z.number().int(),
  origin: draftOriginSchema,
  subject: z.string().nullable(),
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type DraftVersion = z.infer<typeof draftVersionSchema>;

// Website form sender (Phase 6) ------------------------------------------------------------

/** Who writes to companies through their contact forms: these details go into the forms. */
export const formSenderSchema = z.object({
  /** The browser profile that fills and sends forms (a general profile, not research). */
  profileId: id.nullable(),
  name: text(200),
  email: z.union([z.literal(''), z.email().max(320)]),
  phone: text(50),
  company: text(200),
  website: text(300),
});
export type FormSender = z.infer<typeof formSenderSchema>;

// LinkedIn (Phase 7) --------------------------------------------------------------------------

/**
 * The LinkedIn adapter's switch and limits (docs/14, FR-LIN-001…005). Off unless turned on, and
 * only after the risk notice was acknowledged; `auto` is opt-in per action class; the limits may be
 * lowered freely and raised above the product's defaults only with `limitsRaised`.
 */
export const linkedinSettingsSchema = z.object({
  enabled: z.boolean(),
  /** The browser profile signed in to the LinkedIn account. */
  profileId: id.nullable(),
  riskAcknowledgedAt: z.iso.datetime().nullable(),
  autoConnect: z.boolean(),
  autoMessage: z.boolean(),
  limits: z.object({
    connectPerDay: z.number().int().min(0).max(200),
    connectPerWeek: z.number().int().min(0).max(1_000),
    messagePerDay: z.number().int().min(0).max(500),
  }),
  /** The limits are above the product's defaults; the person accepted the risk. */
  limitsRaised: z.boolean(),
});
export type LinkedinSettings = z.infer<typeof linkedinSettingsSchema>;
export const linkedinSettingsUpdateSchema = linkedinSettingsSchema.omit({ riskAcknowledgedAt: true }).extend({
  /** Ticked in the settings: the person read the risk notice. */
  acknowledgeRisk: z.boolean(),
});
