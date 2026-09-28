import type { MailServer } from '@tabreach/protocol';

/** What the email channel needs from an account's servers; wrapped so tests need no real servers. */
export interface MailSettings {
  address: string;
  username: string;
  password: string;
  smtp: MailServer;
  imap: MailServer;
}

export interface SmtpClient {
  /** Submits a raw message; resolves with the server's final response line. */
  send(
    raw: Buffer,
    envelope: { from: string; to: string },
    signal: AbortSignal,
  ): Promise<{ response: string }>;
  verify(signal: AbortSignal): Promise<void>;
  close(): void;
}

export interface MailboxClient {
  /** The path of the Sent folder (special-use \Sent), or null if the server does not mark one. */
  sentFolder(signal: AbortSignal): Promise<string | null>;
  /** Whether a message with this Message-ID is in the folder. */
  hasMessage(folder: string, messageId: string, signal: AbortSignal): Promise<boolean>;
  append(folder: string, raw: Buffer, signal: AbortSignal): Promise<void>;
  /**
   * Messages after \`cursor.lastUid\`, oldest first, at most \`limit\`. When the cursor is empty or
   * UIDVALIDITY changed, returns no messages and the current position (polling starts from now).
   */
  fetchNew(
    folder: string,
    cursor: { uidValidity: number | null; lastUid: number | null },
    limit: number,
    signal: AbortSignal,
  ): Promise<{ uidValidity: number; lastUid: number; messages: { uid: number; raw: Buffer }[] }>;
  close(): Promise<void>;
}

export interface MailClients {
  smtp(settings: MailSettings): SmtpClient;
  /** Connects (and logs in); throws when that fails. */
  mailbox(settings: MailSettings, signal: AbortSignal): Promise<MailboxClient>;
}

/** Position in an inbox: IMAP (UIDVALIDITY, last UID) or Gmail (0, historyId). */
export interface InboxCursor {
  a: number | null;
  b: number | null;
}

/** New inbox messages, provider-neutral, for reply ingestion (ADR 024). */
export interface InboxSource {
  fetchNew(
    cursor: InboxCursor,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    cursor: { a: number; b: number };
    /** `cursor`, when present, is the position right after that message (IMAP). */
    messages: { providerId: string; raw: Buffer; cursor?: { a: number; b: number } }[];
    /** More are waiting: poll again soon. */
    more: boolean;
  }>;
  close(): Promise<void>;
}

/** The provider refused the stored credentials: the account needs the user. */
export class InboxAuthError extends Error {
  override name = 'InboxAuthError';
}
