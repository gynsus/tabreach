import { z } from 'zod';
import {
  browserProfileSchema,
  profileCreateSchema,
  profileDeleteSchema,
  profileUpdateSchema,
  workerProfileHealthSchema,
  workerProfileOpenResultSchema,
  workerProfileOpenSchema,
  workerProfileRefSchema,
  workerSessionRefSchema,
  workerSetModeSchema,
  workerTaskRunSchema,
  workerRenderSchema,
  workerThreadReadSchema,
  threadReadResultSchema,
  workerFormPrepareSchema,
  formPrepareResultSchema,
  workerFormSubmitSchema,
  resolveTargetSchema,
  resolveTargetResultSchema,
  renderResultSchema,
  taskCheckpointSchema,
  taskCheckpointAckSchema,
  taskResultSchema,
  profileCheckSignInSchema,
  interventionSchema,
  interventionResolveSchema,
  overlayContextSchema,
  appControlSchema,
} from './browser.js';
import { aiProviderSchema, aiSettingsInputSchema, aiSettingsSchema, aiUsageSchema } from './ai.js';
import { researchDetailSchema, researchRunSchema, researchStartSchema } from './research.js';
import {
  conversationListRequestSchema,
  conversationSchema,
  conversationSummarySchema,
  reviewRequestSchema,
} from './inbox.js';
import {
  accountUpdateSchema,
  connectionCheckSchema,
  emailAccountSchema,
  gmailAccountInputSchema,
  imapAccountInputSchema,
  oauthLoopbackRequestSchema,
  oauthLoopbackResultSchema,
} from './accounts.js';
import {
  approvalDecisionSchema,
  approvalSchema,
  approveRequestSchema,
  campaignCreateSchema,
  campaignSchema,
  campaignUpdateSchema,
  draftReviseSchema,
  enrollmentListRequestSchema,
  enrollmentSchema,
  enrollReportSchema,
  enrollRequestSchema,
  jobSchema,
  draftVersionSchema,
  policySettingsSchema,
  formSenderSchema,
  uncertainSendSchema,
} from './campaigns.js';
import {
  activityListRequestSchema,
  timelineEntrySchema,
  companyDetailSchema,
  companyInputSchema,
  companySchema,
  companyUpdateSchema,
  contactInputSchema,
  contactListRequestSchema,
  contactSchema,
  contactUpdateSchema,
  exportResultSchema,
  importCommitRequestSchema,
  importPreviewSchema,
  importReportSchema,
  MAX_CSV_CHARS,
  pageOf,
  pageRequestSchema,
  suppressionAddSchema,
  suppressionImportReportSchema,
  suppressionSchema,
  uiSettingsSchema,
} from './prospects.js';

export const componentStatusSchema = z.enum(['ok', 'degraded', 'down', 'unknown']);
export type ComponentStatus = z.infer<typeof componentStatusSchema>;

export const chromeInfoSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  path: z.string().nullable(),
});
export type ChromeInfo = z.infer<typeof chromeInfoSchema>;

export const workerHealthSchema = z.object({
  status: componentStatusSchema,
  node: z.string(),
  playwright: z.string(),
  chrome: chromeInfoSchema,
});
export type WorkerHealth = z.infer<typeof workerHealthSchema>;

export const databaseHealthSchema = z.object({
  status: componentStatusSchema,
  sqliteVersion: z.string().nullable(),
  schemaVersion: z.number().int().nonnegative(),
  detail: z.string().optional(),
});
export type DatabaseHealth = z.infer<typeof databaseHealthSchema>;

export const healthReportSchema = z.object({
  checkedAt: z.iso.datetime(),
  app: z.object({ version: z.string(), electron: z.string().nullable(), node: z.string() }),
  core: z.object({ status: componentStatusSchema }),
  database: databaseHealthSchema,
  /** Result of the startup safeStorage round trip through main. */
  secrets: z.object({ status: componentStatusSchema, detail: z.string().optional() }),
  worker: z.union([workerHealthSchema, z.object({ status: componentStatusSchema, detail: z.string() })]),
});
export type HealthReport = z.infer<typeof healthReportSchema>;

export const launchCheckRequestSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
});
export const launchCheckResultSchema = z.object({
  ok: z.boolean(),
  url: z.string(),
  httpStatus: z.number().int().nullable(),
  title: z.string().nullable(),
  chromeVersion: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type LaunchCheckResult = z.infer<typeof launchCheckResultSchema>;

const byId = z.object({ id: z.uuid() });
const ok = z.object({ ok: z.literal(true) });

export const secretCipherTextSchema = z.object({ ciphertext: z.base64() });

/**
 * Request/response registry. `channel` names the process pair:
 * - app:     renderer -> core
 * - browser: core -> browser worker (and `task.checkpoint`, worker -> core)
 * - host:    core -> main (Electron-only capabilities; and `control.fromTray`, main -> core)
 */
export const requests = {
  'app.health': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: healthReportSchema,
  },
  'browser.launchCheck': {
    channel: 'app',
    kind: 'command',
    request: launchCheckRequestSchema,
    response: launchCheckResultSchema,
  },
  'settings.ui.get': { channel: 'app', kind: 'query', request: z.object({}), response: uiSettingsSchema },
  'settings.ui.update': {
    channel: 'app',
    kind: 'command',
    request: uiSettingsSchema,
    response: uiSettingsSchema,
  },
  'companies.list': {
    channel: 'app',
    kind: 'query',
    request: pageRequestSchema,
    response: pageOf(companySchema),
  },
  'companies.get': {
    channel: 'app',
    kind: 'query',
    request: z.object({ id: z.uuid() }),
    response: companyDetailSchema,
  },
  'companies.create': {
    channel: 'app',
    kind: 'command',
    request: companyInputSchema,
    response: companySchema,
  },
  'companies.update': {
    channel: 'app',
    kind: 'command',
    request: companyUpdateSchema,
    response: companySchema,
  },
  'contacts.list': {
    channel: 'app',
    kind: 'query',
    request: contactListRequestSchema,
    response: pageOf(contactSchema),
  },
  'contacts.get': {
    channel: 'app',
    kind: 'query',
    request: z.object({ id: z.uuid() }),
    response: contactSchema,
  },
  'contacts.create': {
    channel: 'app',
    kind: 'command',
    request: contactInputSchema,
    response: contactSchema,
  },
  'contacts.update': {
    channel: 'app',
    kind: 'command',
    request: contactUpdateSchema,
    response: contactSchema,
  },
  'imports.prospects.preview': {
    channel: 'app',
    kind: 'command',
    request: z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) }),
    response: importPreviewSchema,
  },
  'imports.prospects.commit': {
    channel: 'app',
    kind: 'command',
    request: importCommitRequestSchema,
    response: importReportSchema,
  },
  'exports.prospects': {
    channel: 'app',
    kind: 'command',
    request: z.object({}),
    response: exportResultSchema,
  },
  'suppressions.list': {
    channel: 'app',
    kind: 'query',
    request: pageRequestSchema,
    response: pageOf(suppressionSchema),
  },
  'suppressions.add': {
    channel: 'app',
    kind: 'command',
    request: suppressionAddSchema,
    response: suppressionSchema,
  },
  'suppressions.remove': {
    channel: 'app',
    kind: 'command',
    request: z.object({ id: z.uuid() }),
    response: z.object({ removed: z.boolean() }),
  },
  'suppressions.import': {
    channel: 'app',
    kind: 'command',
    request: z.object({ csv: z.string().min(1).max(MAX_CSV_CHARS) }),
    response: suppressionImportReportSchema,
  },
  'campaigns.list': {
    channel: 'app',
    kind: 'query',
    request: z.object({ includeArchived: z.boolean().default(false) }),
    response: z.object({ items: z.array(campaignSchema) }),
  },
  'campaigns.get': { channel: 'app', kind: 'query', request: byId, response: campaignSchema },
  'campaigns.create': {
    channel: 'app',
    kind: 'command',
    request: campaignCreateSchema,
    response: campaignSchema,
  },
  'campaigns.update': {
    channel: 'app',
    kind: 'command',
    request: campaignUpdateSchema,
    response: campaignSchema,
  },
  'campaigns.launch': { channel: 'app', kind: 'command', request: byId, response: campaignSchema },
  'campaigns.pause': { channel: 'app', kind: 'command', request: byId, response: campaignSchema },
  'campaigns.resume': { channel: 'app', kind: 'command', request: byId, response: campaignSchema },
  'campaigns.archive': { channel: 'app', kind: 'command', request: byId, response: campaignSchema },
  'campaigns.enroll': {
    channel: 'app',
    kind: 'command',
    request: enrollRequestSchema,
    response: enrollReportSchema,
  },
  'enrollments.list': {
    channel: 'app',
    kind: 'query',
    request: enrollmentListRequestSchema,
    response: pageOf(enrollmentSchema),
  },
  'enrollments.pause': { channel: 'app', kind: 'command', request: byId, response: enrollmentSchema },
  'enrollments.resume': { channel: 'app', kind: 'command', request: byId, response: enrollmentSchema },
  'enrollments.stop': { channel: 'app', kind: 'command', request: byId, response: enrollmentSchema },
  'approvals.pending': {
    channel: 'app',
    kind: 'query',
    request: z.object({ campaignId: z.uuid().optional() }),
    response: z.object({ items: z.array(approvalSchema) }),
  },
  'approvals.approve': { channel: 'app', kind: 'command', request: approveRequestSchema, response: ok },
  'approvals.reject': { channel: 'app', kind: 'command', request: approvalDecisionSchema, response: ok },
  'approvals.skip': { channel: 'app', kind: 'command', request: approvalDecisionSchema, response: ok },
  'drafts.history': {
    channel: 'app',
    kind: 'query',
    request: z.object({ draftId: z.uuid() }),
    response: z.object({ items: z.array(draftVersionSchema) }),
  },
  /** The new approval; null for a website form, which is prepared again first (a new approval follows). */
  'drafts.revise': {
    channel: 'app',
    kind: 'command',
    request: draftReviseSchema,
    response: approvalSchema.nullable(),
  },
  'forms.sender.get': { channel: 'app', kind: 'query', request: z.object({}), response: formSenderSchema },
  'forms.sender.update': {
    channel: 'app',
    kind: 'command',
    request: formSenderSchema,
    response: formSenderSchema,
  },
  /** The screenshot of the prepared form an approval covers (base64 PNG), if there is one. */
  'forms.screenshot': {
    channel: 'app',
    kind: 'query',
    request: z.object({ approvalId: z.uuid() }),
    response: z.object({ png: z.string().nullable() }),
  },
  'policy.settings.get': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: policySettingsSchema,
  },
  'policy.settings.update': {
    channel: 'app',
    kind: 'command',
    request: policySettingsSchema,
    response: policySettingsSchema,
  },
  'jobs.needsAttention': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: z.object({ items: z.array(jobSchema) }),
  },
  'conversations.list': {
    channel: 'app',
    kind: 'query',
    request: conversationListRequestSchema,
    response: z.object({
      items: z.array(conversationSummarySchema),
      total: z.number().int().nonnegative(),
      unread: z.number().int().nonnegative(),
    }),
  },
  'conversations.get': { channel: 'app', kind: 'query', request: byId, response: conversationSchema },
  'conversations.markRead': { channel: 'app', kind: 'command', request: byId, response: ok },
  'conversations.review': { channel: 'app', kind: 'command', request: reviewRequestSchema, response: ok },
  'research.start': {
    channel: 'app',
    kind: 'command',
    request: researchStartSchema,
    response: researchRunSchema,
  },
  'research.list': {
    channel: 'app',
    kind: 'query',
    request: z.object({ companyId: z.uuid() }),
    response: z.object({ items: z.array(researchRunSchema) }),
  },
  'research.get': { channel: 'app', kind: 'query', request: byId, response: researchDetailSchema },
  'ai.settings.get': { channel: 'app', kind: 'query', request: z.object({}), response: aiSettingsSchema },
  'ai.settings.update': {
    channel: 'app',
    kind: 'command',
    request: aiSettingsInputSchema,
    response: aiSettingsSchema,
  },
  /** Stores the provider API key encrypted; it is never returned. */
  'ai.setKey': {
    channel: 'app',
    kind: 'command',
    request: z.object({ provider: aiProviderSchema, apiKey: z.string().trim().min(10).max(500) }),
    response: ok,
  },
  'ai.removeKey': {
    channel: 'app',
    kind: 'command',
    request: z.object({ provider: aiProviderSchema }),
    response: ok,
  },
  /** One minimal call with the stored key and the classification model. */
  'ai.testKey': {
    channel: 'app',
    kind: 'command',
    request: z.object({}),
    response: z.object({ ok: z.boolean(), error: z.string().optional() }),
  },
  'ai.usage': {
    channel: 'app',
    kind: 'query',
    request: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    response: aiUsageSchema,
  },
  'accounts.list': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: z.object({ items: z.array(emailAccountSchema) }),
  },
  /** Tests the connection first; saves only if SMTP and IMAP both work. */
  'accounts.connectImap': {
    channel: 'app',
    kind: 'command',
    request: imapAccountInputSchema,
    response: emailAccountSchema,
  },
  /** Opens Google's consent page in the system browser and waits for the user (ADR 016). */
  'accounts.connectGmail': {
    channel: 'app',
    kind: 'command',
    request: gmailAccountInputSchema,
    response: emailAccountSchema,
  },
  'accounts.update': {
    channel: 'app',
    kind: 'command',
    request: accountUpdateSchema,
    response: emailAccountSchema,
  },
  'accounts.test': { channel: 'app', kind: 'command', request: byId, response: connectionCheckSchema },
  'accounts.disconnect': { channel: 'app', kind: 'command', request: byId, response: ok },
  /** Whether the contact is on hold after a reply (theirs, or their company's). */
  'contacts.replyHold': {
    channel: 'app',
    kind: 'query',
    request: byId,
    response: z.object({ hold: z.enum(['replied', 'company_replied']).nullable() }),
  },
  /** The user allows campaigns to write to this contact again; earlier replies stop counting. */
  'contacts.releaseReplyHold': { channel: 'app', kind: 'command', request: byId, response: ok },
  'sideEffects.uncertain': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: z.object({ items: z.array(uncertainSendSchema) }),
  },
  /** A person settles an outcome TabReach could not verify (ADR 018: user_confirmation). */
  'sideEffects.resolve': {
    channel: 'app',
    kind: 'command',
    request: z.object({ id: z.uuid(), outcome: z.enum(['completed', 'not_sent']) }),
    response: ok,
  },
  'jobs.retry': { channel: 'app', kind: 'command', request: byId, response: ok },
  'jobs.dismiss': { channel: 'app', kind: 'command', request: byId, response: ok },
  'activity.list': {
    channel: 'app',
    kind: 'query',
    request: activityListRequestSchema,
    /** hasMore: older events exist; ask again with `before` set to the last item. */
    response: z.object({ items: z.array(timelineEntrySchema), hasMore: z.boolean() }),
  },
  'worker.health': {
    channel: 'browser',
    kind: 'query',
    request: z.object({}),
    response: workerHealthSchema,
  },
  'worker.launchCheck': {
    channel: 'browser',
    kind: 'command',
    request: launchCheckRequestSchema,
    response: launchCheckResultSchema,
  },
  // Browser profiles (Phase 5a): the app asks core; core owns the records and asks the worker.
  'profiles.list': {
    channel: 'app',
    kind: 'query',
    request: z.object({ includeArchived: z.boolean().default(false) }),
    response: z.object({ items: z.array(browserProfileSchema) }),
  },
  'profiles.create': {
    channel: 'app',
    kind: 'command',
    request: profileCreateSchema,
    response: browserProfileSchema,
  },
  'profiles.update': {
    channel: 'app',
    kind: 'command',
    request: profileUpdateSchema,
    response: browserProfileSchema,
  },
  'profiles.archive': { channel: 'app', kind: 'command', request: byId, response: browserProfileSchema },
  'profiles.delete': { channel: 'app', kind: 'command', request: profileDeleteSchema, response: ok },
  /** Opens the profile in a visible Chrome window, under the user's control. */
  'profiles.open': {
    channel: 'app',
    kind: 'command',
    request: byId.extend({ startUrl: z.url().nullable().default(null) }),
    response: browserProfileSchema,
  },
  'profiles.close': { channel: 'app', kind: 'command', request: byId, response: browserProfileSchema },
  'profiles.focus': { channel: 'app', kind: 'command', request: byId, response: ok },
  'profiles.check': { channel: 'app', kind: 'command', request: byId, response: browserProfileSchema },
  /** Opens the profile under automation and recognizes the site's page: signed in, sign-in, challenge. */
  'profiles.checkSignIn': {
    channel: 'app',
    kind: 'command',
    request: profileCheckSignInSchema,
    response: browserProfileSchema,
  },
  'interventions.list': {
    channel: 'app',
    kind: 'query',
    request: z.object({}),
    response: z.object({ items: z.array(interventionSchema) }),
  },
  'interventions.resolve': {
    channel: 'app',
    kind: 'command',
    request: interventionResolveSchema,
    response: ok,
  },
  'profile.open': {
    channel: 'browser',
    kind: 'command',
    request: workerProfileOpenSchema,
    response: workerProfileOpenResultSchema,
  },
  'profile.close': { channel: 'browser', kind: 'command', request: workerSessionRefSchema, response: ok },
  'profile.healthCheck': {
    channel: 'browser',
    kind: 'query',
    request: workerProfileRefSchema,
    response: workerProfileHealthSchema,
  },
  /** Removes the profile's directory (credential-equivalent data, docs/08); the profile must be closed. */
  'profile.delete': { channel: 'browser', kind: 'command', request: workerProfileRefSchema, response: ok },
  'session.focus': { channel: 'browser', kind: 'command', request: workerSessionRefSchema, response: ok },
  'session.setMode': { channel: 'browser', kind: 'command', request: workerSetModeSchema, response: ok },
  'session.setOverlay': {
    channel: 'browser',
    kind: 'command',
    request: z.object({ sessionId: z.uuid(), context: overlayContextSchema.nullable() }),
    response: ok,
  },
  /** Stops every browser task at once and pauses every session (docs/19). */
  'worker.emergencyStop': { channel: 'browser', kind: 'command', request: z.object({}), response: ok },
  'app.control.get': { channel: 'app', kind: 'query', request: z.object({}), response: appControlSchema },
  'app.pauseAll': { channel: 'app', kind: 'command', request: z.object({}), response: appControlSchema },
  'app.resumeAll': { channel: 'app', kind: 'command', request: z.object({}), response: appControlSchema },
  'app.emergencyStop': { channel: 'app', kind: 'command', request: z.object({}), response: appControlSchema },
  'app.setKeepAwake': {
    channel: 'app',
    kind: 'command',
    request: z.object({ keepAwake: z.boolean() }),
    response: appControlSchema,
  },
  /** The person takes a session over: automation stops there (docs/11). */
  'profiles.takeControl': { channel: 'app', kind: 'command', request: byId, response: browserProfileSchema },
  /** Hands back: the page is checked again before automation continues (docs/11 "Resume validation"). */
  'profiles.returnControl': {
    channel: 'app',
    kind: 'command',
    request: byId,
    response: browserProfileSchema,
  },
  /** Worker → core (the one browser request core answers): the `about_to_commit` checkpoint. */
  'task.checkpoint': {
    channel: 'browser',
    kind: 'command',
    request: taskCheckpointSchema,
    response: taskCheckpointAckSchema,
  },
  /** The job waiting for a task was cancelled: the worker stops it at its next step. */
  'task.cancel': {
    channel: 'browser',
    kind: 'command',
    request: z.object({ taskId: z.uuid() }),
    response: ok,
  },
  /** Worker → core: bounded semantic resolution (ADR 013) through the AI gateway. */
  'ai.resolveTarget': {
    channel: 'browser',
    kind: 'query',
    request: resolveTargetSchema,
    response: resolveTargetResultSchema,
  },
  /** PrepareFormSubmission (docs/14, Phase 6): nothing is sent. */
  'form.prepare': {
    channel: 'browser',
    kind: 'command',
    request: workerFormPrepareSchema,
    response: formPrepareResultSchema,
  },
  /** ExecuteFormSubmission: sends through the `about_to_commit` checkpoint; results as `task.run`. */
  'form.submit': {
    channel: 'browser',
    kind: 'command',
    request: workerFormSubmitSchema,
    response: taskResultSchema,
  },
  /** Reads a conversation (FR-LIN-004): nothing is clicked that sends anything. */
  'thread.read': {
    channel: 'browser',
    kind: 'command',
    request: workerThreadReadSchema,
    response: threadReadResultSchema,
  },
  /** RenderPageForResearch (docs/16, ADR 027). */
  'task.render': {
    channel: 'browser',
    kind: 'command',
    request: workerRenderSchema,
    response: renderResultSchema,
  },
  /** Runs one browser task in a session under automation; refused in any other control mode. */
  'task.run': {
    channel: 'browser',
    kind: 'command',
    request: workerTaskRunSchema,
    response: taskResultSchema,
  },
  /** Core → main: one OAuth authorization through the system browser and a loopback redirect. */
  'oauth.loopback': {
    channel: 'host',
    kind: 'command',
    request: oauthLoopbackRequestSchema,
    response: oauthLoopbackResultSchema,
  },
  /** Main → core: the Mac is going to sleep; stop claiming jobs (docs/17, "Sleep"). */
  'power.suspend': { channel: 'host', kind: 'command', request: z.object({}), response: ok },
  /** Main → core: the Mac woke up; re-plan overdue work into the active windows. */
  'power.resume': { channel: 'host', kind: 'command', request: z.object({}), response: ok },
  /** Core → main: keep the Mac awake or let it sleep (FR-APP-004). */
  'power.keepAwake': {
    channel: 'host',
    kind: 'command',
    request: z.object({ on: z.boolean() }),
    response: ok,
  },
  /** Main → core: the menu-bar item's Pause all / Resume / Emergency stop. */
  'control.fromTray': {
    channel: 'host',
    kind: 'command',
    request: z.object({ action: z.enum(['pause', 'resume', 'emergency_stop']) }),
    response: ok,
  },
  /** Core → main: a native notification (a person is needed). */
  'app.notify': {
    channel: 'host',
    kind: 'command',
    request: z.object({ title: z.string().max(200), body: z.string().max(500) }),
    response: ok,
  },
  'secret.encrypt': {
    channel: 'host',
    kind: 'command',
    request: z.object({ plaintext: z.string().min(1) }),
    response: secretCipherTextSchema,
  },
  'secret.decrypt': {
    channel: 'host',
    kind: 'command',
    request: secretCipherTextSchema,
    response: z.object({ plaintext: z.string() }),
  },
} as const;

export type RequestType = keyof typeof requests;
export type Channel = (typeof requests)[RequestType]['channel'];
export type RequestsOn<C extends Channel> = {
  [K in RequestType]: (typeof requests)[K]['channel'] extends C ? K : never;
}[RequestType];
export type RequestOf<T extends RequestType> = z.input<(typeof requests)[T]['request']>;
export type ResponseOf<T extends RequestType> = z.output<(typeof requests)[T]['response']>;

export function isRequestType(type: string): type is RequestType {
  return Object.hasOwn(requests, type);
}
