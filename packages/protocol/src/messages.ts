import { z } from 'zod';
import {
  accountUpdateSchema,
  connectionCheckSchema,
  emailAccountSchema,
  imapAccountInputSchema,
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
  policySettingsSchema,
} from './campaigns.js';
import {
  actionEventSchema,
  activityListRequestSchema,
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
 * - browser: core -> browser worker
 * - host:    core -> main (Electron-only capabilities)
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
  'drafts.revise': { channel: 'app', kind: 'command', request: draftReviseSchema, response: approvalSchema },
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
  'accounts.update': {
    channel: 'app',
    kind: 'command',
    request: accountUpdateSchema,
    response: emailAccountSchema,
  },
  'accounts.test': { channel: 'app', kind: 'command', request: byId, response: connectionCheckSchema },
  'accounts.disconnect': { channel: 'app', kind: 'command', request: byId, response: ok },
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
    response: z.object({ items: z.array(actionEventSchema) }),
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
  /** Main → core: the Mac is going to sleep; stop claiming jobs (docs/17, "Sleep"). */
  'power.suspend': { channel: 'host', kind: 'command', request: z.object({}), response: ok },
  /** Main → core: the Mac woke up; re-plan overdue work into the active windows. */
  'power.resume': { channel: 'host', kind: 'command', request: z.object({}), response: ok },
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
