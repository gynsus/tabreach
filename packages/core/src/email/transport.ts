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
  close(): Promise<void>;
}

export interface MailClients {
  smtp(settings: MailSettings): SmtpClient;
  /** Connects (and logs in); throws when that fails. */
  mailbox(settings: MailSettings, signal: AbortSignal): Promise<MailboxClient>;
}
