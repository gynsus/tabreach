import { z } from 'zod';

/** Email conversations and replies (docs/06 "Inbox", docs/14 "Common email behaviour"). */

export const messageClassificationSchema = z.enum(['reply', 'out_of_office', 'auto', 'bounce']);
export const matchStrengthSchema = z.enum(['thread', 'contact_address', 'domain_only']);
export const reviewStatusSchema = z.enum(['none', 'pending', 'confirmed', 'dismissed']);

/** What AI read in a reply. */
export const replyAiLabelSchema = z.enum([
  'interested',
  'not_interested',
  'opt_out',
  'out_of_office',
  'other',
]);

export const conversationSummarySchema = z.object({
  id: z.uuid(),
  /** The user's own mailbox the conversation goes through. */
  accountAddress: z.string(),
  /** The contact's email address, when the conversation has a contact. */
  contactAddress: z.string().nullable(),
  contactId: z.uuid().nullable(),
  companyId: z.uuid().nullable(),
  /** Contact name, or the company for a possible reply that matched only its domain. */
  title: z.string(),
  lastMessageAt: z.iso.datetime(),
  lastSnippet: z.string(),
  lastClassification: messageClassificationSchema.nullable(),
  /** The AI label of the latest incoming message, when it has one. */
  lastLabel: replyAiLabelSchema.nullable(),
  unread: z.boolean(),
  /** A possible reply waits for the user to confirm or dismiss it. */
  needsReview: z.boolean(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

export const conversationMessageSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['inbound', 'outbound']),
  from: z.string().nullable(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  classification: messageClassificationSchema.nullable(),
  /** What AI read in a reply (interested, opt-out, …); null until classified or without AI. */
  label: replyAiLabelSchema.nullable(),
  matchStrength: matchStrengthSchema.nullable(),
  reviewStatus: reviewStatusSchema,
  occurredAt: z.iso.datetime(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

export const conversationSchema = conversationSummarySchema.extend({
  messages: z.array(conversationMessageSchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const conversationListRequestSchema = z.object({
  filter: z.enum(['all', 'unread', 'review']).default('all'),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

export const reviewRequestSchema = z.object({
  messageId: z.uuid(),
  /** confirm: treat it as a reply from the company (stops its sequences if the policy says so). */
  decision: z.enum(['confirm', 'dismiss']),
});
