import MailComposer from 'nodemailer/lib/mail-composer';

export interface ComposeInput {
  from: { address: string; name: string | null };
  to: { address: string; name: string | null };
  subject: string | null;
  body: string;
  messageId: string;
  date: Date;
  /** Threading (RFC 5322 §3.6.4): the Message-ID answered, and the thread's ids so far. */
  inReplyTo?: string | null | undefined;
  references?: string | null | undefined;
}

/**
 * The Message-ID of a send, derived from its ledger key: the same intent always carries the same
 * id, so an interrupted send can be found in Sent without having stored anything first (ADR 016).
 * The domain is the sender's, as RFC 5322 recommends; nothing in it names TabReach.
 */
export function messageIdFor(idempotencyKey: string, senderAddress: string): string {
  const domain = senderAddress.split('@')[1] ?? 'localhost';
  return `<${idempotencyKey.slice(0, 40)}@${domain}>`;
}

/** A complete RFC 5322 message (plain text, UTF-8), used byte for byte for SMTP and for IMAP APPEND. */
export async function composeMessage(input: ComposeInput): Promise<Buffer> {
  const composer = new MailComposer({
    from: input.from.name ? { name: input.from.name, address: input.from.address } : input.from.address,
    to: input.to.name ? { name: input.to.name, address: input.to.address } : input.to.address,
    subject: input.subject ?? '',
    text: input.body,
    messageId: input.messageId,
    date: input.date,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references ? { references: input.references } : {}),
    textEncoding: 'quoted-printable',
  });
  return composer.compile().build();
}
