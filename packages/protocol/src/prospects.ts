import { z } from 'zod';

/** Shared DTOs for prospects, imports, suppressions and activity (docs/06-API-CONTRACT.md). */

const id = z.uuid();
const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => text(max).nullish();

export const customFieldValueSchema = z.union([z.string().max(2_000), z.number(), z.boolean()]);
export const customFieldsSchema = z.record(z.string().min(1).max(100), customFieldValueSchema);
export type CustomFields = z.infer<typeof customFieldsSchema>;

export const recordStatusSchema = z.enum(['active', 'archived']);
export const emailStatusSchema = z.enum(['unknown', 'valid', 'bounced', 'invalid']);

export const pageRequestSchema = z.object({
  search: text(200).optional(),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

const tagsSchema = z.array(text(60).min(1)).max(50);

// Companies ---------------------------------------------------------------------------------

export const companySchema = z.object({
  id,
  name: z.string(),
  domain: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  country: z.string().nullable(),
  city: z.string().nullable(),
  status: recordStatusSchema,
  tags: z.array(z.string()),
  customFields: customFieldsSchema,
  contactCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Company = z.infer<typeof companySchema>;

export const companyInputSchema = z.object({
  name: text(300).min(1),
  website: optionalText(500),
  country: optionalText(100),
  city: optionalText(100),
  tags: tagsSchema.optional(),
  customFields: customFieldsSchema.optional(),
});
export type CompanyInput = z.infer<typeof companyInputSchema>;

export const companyUpdateSchema = companyInputSchema.partial().extend({
  id,
  status: recordStatusSchema.optional(),
});
export type CompanyUpdate = z.infer<typeof companyUpdateSchema>;

// Contacts ----------------------------------------------------------------------------------

export const contactSchema = z.object({
  id,
  companyId: z.uuid().nullable(),
  companyName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  fullName: z.string().nullable(),
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  emailStatus: emailStatusSchema,
  linkedinUrl: z.string().nullable(),
  status: recordStatusSchema,
  tags: z.array(z.string()),
  customFields: customFieldsSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Contact = z.infer<typeof contactSchema>;

export const contactInputSchema = z.object({
  companyId: z.uuid().nullish(),
  firstName: optionalText(100),
  lastName: optionalText(100),
  fullName: optionalText(200),
  jobTitle: optionalText(200),
  email: optionalText(320),
  linkedinUrl: optionalText(500),
  tags: tagsSchema.optional(),
  customFields: customFieldsSchema.optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

export const contactUpdateSchema = contactInputSchema.extend({
  id,
  status: recordStatusSchema.optional(),
});
export type ContactUpdate = z.infer<typeof contactUpdateSchema>;

export const contactListRequestSchema = pageRequestSchema.extend({ companyId: z.uuid().optional() });

export const companyDetailSchema = companySchema.extend({ contacts: z.array(contactSchema) });
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

// Import / export ---------------------------------------------------------------------------

export const importFieldSchema = z.enum([
  'ignore',
  'company.name',
  'company.website',
  'company.country',
  'company.city',
  'company.tags',
  'contact.firstName',
  'contact.lastName',
  'contact.fullName',
  'contact.email',
  'contact.jobTitle',
  'contact.linkedinUrl',
  'contact.tags',
  'contact.custom',
  'company.custom',
]);
export type ImportField = z.infer<typeof importFieldSchema>;

/** 20 MB of CSV text is far above any realistic prospect list and keeps IPC bounded. */
export const MAX_CSV_CHARS = 20_000_000;
const csvSchema = z.string().min(1).max(MAX_CSV_CHARS);

export const importPreviewSchema = z.object({
  headers: z.array(z.string()),
  sampleRows: z.array(z.array(z.string())),
  rowCount: z.number().int().nonnegative(),
  suggestedMapping: z.array(importFieldSchema),
  delimiter: z.string(),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;

export const onMatchSchema = z.enum(['skip', 'fill_empty', 'overwrite']);
export type OnMatch = z.infer<typeof onMatchSchema>;

export const importCommitRequestSchema = z.object({
  csv: csvSchema,
  /** One entry per CSV column, in header order. */
  mapping: z.array(importFieldSchema).min(1),
  onMatch: onMatchSchema.default('fill_empty'),
});

/** `reason` is an error key such as `email.invalid` or `row.empty` that the UI translates. */
export const importRowErrorSchema = z.object({ row: z.number().int().positive(), reason: z.string() });
export const importReportSchema = z.object({
  importId: z.uuid(),
  totalRows: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  companiesCreated: z.number().int().nonnegative(),
  contactsCreated: z.number().int().nonnegative(),
  errors: z.array(importRowErrorSchema),
  errorsTruncated: z.boolean(),
});
export type ImportReport = z.infer<typeof importReportSchema>;

export const exportResultSchema = z.object({
  filename: z.string(),
  csv: z.string(),
  rows: z.number().int().nonnegative(),
});

// Suppressions ------------------------------------------------------------------------------

export const suppressionKindSchema = z.enum(['email', 'domain', 'company', 'profile_url']);
export type SuppressionKind = z.infer<typeof suppressionKindSchema>;
export const suppressionReasonSchema = z.enum(['opt_out', 'bounce', 'manual', 'imported']);

export const suppressionSchema = z.object({
  id,
  kind: suppressionKindSchema,
  value: z.string(),
  reason: suppressionReasonSchema,
  createdAt: z.iso.datetime(),
});
export type Suppression = z.infer<typeof suppressionSchema>;

export const suppressionAddSchema = z.object({
  kind: suppressionKindSchema,
  value: text(500).min(1),
});

export const suppressionImportReportSchema = z.object({
  added: z.number().int().nonnegative(),
  alreadyPresent: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
});

// Activity ----------------------------------------------------------------------------------

export const actorTypeSchema = z.enum(['user', 'system', 'ai', 'browser_worker', 'channel_adapter']);

export const actionEventSchema = z.object({
  id,
  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  actorType: actorTypeSchema,
  actionType: z.string(),
  objectType: z.string().nullable(),
  objectId: z.string().nullable(),
  status: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type ActionEvent = z.infer<typeof actionEventSchema>;

export const activityListRequestSchema = z.object({
  objectType: z.enum(['company', 'contact', 'suppression', 'import']).optional(),
  objectId: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

// UI settings -------------------------------------------------------------------------------

export const languageSchema = z.enum(['en', 'ru']);
export type Language = z.infer<typeof languageSchema>;
export const uiSettingsSchema = z.object({ language: languageSchema });
export type UiSettings = z.infer<typeof uiSettingsSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().nonnegative() });
