import { z } from 'zod';

/** Single catalogue of audit object and action types (core writes them, the UI filters and labels them). */
export const auditObjectTypeSchema = z.enum(['company', 'contact', 'suppression', 'import', 'export']);
export type AuditObjectType = z.infer<typeof auditObjectTypeSchema>;

export const auditActionTypes = [
  'company.created',
  'company.updated',
  'contact.created',
  'contact.updated',
  'import.committed',
  'export.created',
  'suppression.added',
  'suppression.removed',
] as const;
export type AuditActionType = (typeof auditActionTypes)[number];
