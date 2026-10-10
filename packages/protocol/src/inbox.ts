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

/** Limits of a reply written in the inbox. */
export const MAX_REPLY_SUBJECT = 300;
export const MAX_REPLY_BODY = 20_000;

/**
 * A reply the user writes and sends from the inbox (ADR 031). `sending` until the outcome is known;
 * `unknown` waits for a check or for the user under Needs attention; `failed` can be sent again.
 */
export const manualReplyStatusSchema = z.enum(['sending', 'sent', 'failed', 'unknown']);
export const manualReplySchema = z.object({
  id: z.uuid(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  status: manualReplyStatusSchema,
  /** Why it was not sent (`suppression.email`, `auth_failed`, …); null otherwise. */
  errorClass: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ManualReply = z.infer<typeof manualReplySchema>;

export const conversationSchema = conversationSummarySchema.extend({
  messages: z.array(conversationMessageSchema),
  /** The message a reply would answer (the latest human reply), or null when there is none. */
  replyTarget: z.object({ messageId: z.uuid(), address: z.string(), subject: z.string() }).nullable(),
  /** Replies written here that are not (yet) known as sent; sent ones are in `messages`. */
  replies: z.array(manualReplySchema),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const replyDraftRequestSchema = z.object({
  conversationId: z.uuid(),
  /** The user's notes for this reply ("offer Thursday", "decline politely"); may be empty. */
  instructions: z.string().max(1_000).default(''),
});

export const replySendSchema = z.object({
  conversationId: z.uuid(),
  /** The incoming message answered: the reply goes to its sender, in its thread. */
  messageId: z.uuid(),
  subject: z.string().trim().min(1).max(MAX_REPLY_SUBJECT),
  body: z.string().trim().min(1).max(MAX_REPLY_BODY),
});

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
