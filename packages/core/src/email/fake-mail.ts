import { serverSavesSent } from './accounts.js';
import type { MailClients, MailboxClient, MailSettings, SmtpClient } from './transport.js';

/** What the next SMTP submission does. `hang_*`: never answers (core "dies" before/after the server took it). */
export type SmtpBehaviour =
  | 'accept'
  | 'hang_before_accept'
  | 'hang_after_accept'
  | { error: { code?: string; command?: string; responseCode?: number } };

/**
 * An in-memory mail server for tests: SMTP submissions land in `delivered`, and — when the
 * server keeps sent mail — in the Sent folder, which IMAP searches by Message-ID.
 */
export class FakeMail implements MailClients {
  readonly delivered: { raw: string; to: string; messageId: string }[] = [];
  readonly sent: string[] = [];
  /** Whether the server keeps sent mail itself; by default decided from the SMTP host, like the product does. */
  serverSavesSent: boolean | 'by_host' = 'by_host';
  /** Submissions that reached the server (including ones that then hang). */
  attempts = 0;
  sentFolderName: string | null = 'Sent';
  password = 'app-password';
  mailboxDown = false;
  /** The inbox as the server has it: UIDs are assigned on arrival. */
  readonly inbox: { uid: number; raw: Buffer }[] = [];
  uidValidity = 1;
  private nextUid = 1;

  /** A message arrives in the inbox. */
  receive(raw: string): void {
    this.inbox.push({ uid: this.nextUid++, raw: Buffer.from(raw.replace(/\r?\n/g, '\r\n')) });
  }
  private readonly next: SmtpBehaviour[] = [];

  queue(...behaviours: SmtpBehaviour[]): void {
    this.next.push(...behaviours);
  }

  smtp(settings: MailSettings): SmtpClient {
    return {
      send: async (raw, envelope) => {
        if (settings.password !== this.password)
          throw Object.assign(new Error('auth'), { code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 });
        const behaviour = this.next.shift() ?? 'accept';
        this.attempts++;
        if (behaviour === 'hang_before_accept') return new Promise<never>(() => {});
        if (typeof behaviour === 'object') throw Object.assign(new Error('smtp'), behaviour.error);
        const text = raw.toString('utf8');
        const messageId = /^Message-ID:\s*(<[^>]+>)/im.exec(text)?.[1] ?? '';
        this.delivered.push({ raw: text, to: envelope.to, messageId });
        const saves =
          this.serverSavesSent === 'by_host' ? serverSavesSent(settings.smtp.host) : this.serverSavesSent;
        if (saves) this.sent.push(messageId);
        if (behaviour === 'hang_after_accept') return new Promise<never>(() => {});
        return { response: '250 2.0.0 OK queued' };
      },
      verify: async () => {
        if (settings.password !== this.password)
          throw Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 });
      },
      close: () => {},
    };
  }

  async mailbox(settings: MailSettings): Promise<MailboxClient> {
    if (this.mailboxDown) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    if (settings.password !== this.password)
      throw Object.assign(new Error('auth'), { authenticationFailed: true });
    return {
      sentFolder: async () => this.sentFolderName,
      hasMessage: async (_folder, messageId) => this.sent.includes(messageId),
      append: async (_folder, raw) => {
        this.sent.push(/^Message-ID:\s*(<[^>]+>)/im.exec(raw.toString('utf8'))?.[1] ?? '');
      },
      fetchNew: async (_folder, cursor, limit) => {
        const top = this.nextUid - 1;
        if (cursor.uidValidity !== this.uidValidity || cursor.lastUid === null) {
          return { uidValidity: this.uidValidity, lastUid: top, messages: [] };
        }
        const lastUid = cursor.lastUid;
        const messages = this.inbox.filter((m) => m.uid > lastUid).slice(0, limit);
        return { uidValidity: this.uidValidity, lastUid: messages.at(-1)?.uid ?? lastUid, messages };
      },
      close: async () => {},
    };
  }
}
