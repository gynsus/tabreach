import { z } from 'zod';

/** Single catalogue of audit object and action types (core writes them, the UI filters and labels them). */
export const auditObjectTypeSchema = z.enum([
  'company',
  'contact',
  'suppression',
  'import',
  'export',
  'campaign',
  'enrollment',
  'approval',
  'side_effect',
  'job',
  'settings',
]);
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
  'campaign.created',
  'campaign.updated',
  'campaign.launched',
  'campaign.paused',
  'campaign.resumed',
  'campaign.archived',
  'campaign.enrolled',
  'enrollment.paused',
  'enrollment.resumed',
  'enrollment.stopped',
  'enrollment.completed',
  'approval.requested',
  'approval.approved',
  'approval.rejected',
  'approval.skipped',
  'draft.revised',
  'message.send',
  'policy.updated',
  'job.retried',
  'job.dismissed',
] as const;
export type AuditActionType = (typeof auditActionTypes)[number];
