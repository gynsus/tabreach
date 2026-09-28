import { ImapFlow } from 'imapflow';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type { MailClients, MailboxClient, MailSettings, SmtpClient } from './transport.js';

const TIMEOUT_MS = 60_000;
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

function abortable<T>(signal: AbortSignal, work: Promise<T>, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

interface ClientOptions {
  /** Tests only: talk plaintext to a server on 127.0.0.1 instead of requiring STARTTLS. */
  plaintextLoopback: boolean;
}

/** Where an SMTP attempt failed: only failures before \`submit\` prove that nothing was handed over. */
export type SmtpStage = 'connect' | 'auth' | 'submit';

function staged(error: unknown, stage: SmtpStage): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  return Object.assign(e, { stage });
}

function smtpClient(s: MailSettings, o: ClientOptions): SmtpClient {
  const plaintext = o.plaintextLoopback && s.smtp.host === '127.0.0.1';
  const options = {
    host: s.smtp.host,
    port: s.smtp.port,
    secure: s.smtp.security === 'tls' && !plaintext,
    requireTLS: s.smtp.security === 'starttls' && !plaintext,
    ignoreTLS: plaintext,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
    logger: false,
    debug: false,
  };
  const open: SMTPConnection[] = [];
  const closeAll = () => open.splice(0).forEach((c) => c.close());

  /**
   * One connection, driven stage by stage. nodemailer reports every lost connection as \`CONN\`,
   * whatever it was doing, so the stage is tracked here (ADR 018: no automatic duplicate).
   */
  const session = async <T>(
    signal: AbortSignal,
    submit: ((c: SMTPConnection) => Promise<T>) | null,
  ): Promise<T | undefined> => {
    const connection = new SMTPConnection(options);
    open.push(connection);
    let stage: SmtpStage = 'connect';
    let failed: ((e: unknown) => void) | null = null;
    // Errors after a callback has run arrive as events; they belong to the current stage.
    connection.on('error', (e: unknown) => failed?.(e));
    const step = <R>(stageName: SmtpStage, run: (done: (err: unknown, value?: R) => void) => void) =>
      abortable(
        signal,
        new Promise<R>((resolve, reject) => {
          stage = stageName;
          failed = (e) => reject(staged(e, stage));
          run((err, value) => (err ? reject(staged(err, stage)) : resolve(value as R)));
        }),
        () => connection.close(),
      );
    try {
      await step<void>('connect', (done) => connection.connect((err) => done(err ?? null)));
      await step<void>('auth', (done) =>
        connection.login({ user: s.username, pass: s.password }, (err) => done(err)),
      );
      return submit ? await submit(connection) : undefined;
    } finally {
      connection.quit();
      open.splice(open.indexOf(connection), 1);
    }
  };

  return {
    async send(raw, envelope, signal) {
      const info = await session(signal, (connection) =>
        abortable(
          signal,
          new Promise<{ response: string }>((resolve, reject) => {
            connection.on('error', (e: unknown) => reject(staged(e, 'submit')));
            connection.send({ from: envelope.from, to: [envelope.to] }, raw, (err, result) =>
              err ? reject(staged(err, 'submit')) : resolve({ response: String(result?.response ?? '') }),
            );
          }),
          () => connection.close(),
        ),
      );
      return info ?? { response: '' };
    },
    async verify(signal) {
      await session(signal, null);
    },
    close: closeAll,
  };
}

async function mailboxClient(s: MailSettings, signal: AbortSignal): Promise<MailboxClient> {
  const client = new ImapFlow({
    host: s.imap.host,
    port: s.imap.port,
    secure: s.imap.security === 'tls',
    doSTARTTLS: s.imap.security === 'starttls' ? true : undefined,
    auth: { user: s.username, pass: s.password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
  const drop = () => client.close();
  await abortable(signal, client.connect(), drop);
  return {
    async sentFolder(sig) {
      const folders = await abortable(sig, client.list(), drop);
      return folders.find((f) => f.specialUse === '\\Sent')?.path ?? null;
    },
    async hasMessage(folder, messageId, sig) {
      const lock = await abortable(sig, client.getMailboxLock(folder, { readOnly: true }), drop);
      try {
        const found = await abortable(
          sig,
          client.search({ header: { 'message-id': messageId } }, { uid: true }),
          drop,
        );
        return Array.isArray(found) && found.length > 0;
      } finally {
        lock.release();
      }
    },
    async fetchNew(folder, cursor, limit, sig) {
      const lock = await abortable(sig, client.getMailboxLock(folder, { readOnly: true }), drop);
      try {
        const box = client.mailbox;
        if (!box) throw new Error('No mailbox selected');
        const uidValidity = Number(box.uidValidity);
        const top = Number(box.uidNext) - 1;
        if (cursor.uidValidity !== uidValidity || cursor.lastUid === null) {
          return { uidValidity, lastUid: top, messages: [] };
        }
        const messages: { uid: number; raw: Buffer }[] = [];
        let lastUid = cursor.lastUid;
        if (top > cursor.lastUid) {
          for await (const msg of client.fetch(
            `${cursor.lastUid + 1}:*`,
            { uid: true, size: true, source: true },
            { uid: true },
          )) {
            if (sig.aborted) break;
            if (msg.uid <= cursor.lastUid) continue;
            // Very large messages are skipped (not kept); the cursor still moves past them.
            if (msg.source && (msg.size ?? 0) <= MAX_MESSAGE_BYTES)
              messages.push({ uid: msg.uid, raw: msg.source });
            lastUid = Math.max(lastUid, msg.uid);
            if (messages.length >= limit) break;
          }
        }
        return { uidValidity, lastUid, messages: messages.sort((a, b) => a.uid - b.uid) };
      } finally {
        lock.release();
      }
    },
    async append(folder, raw, sig) {
      await abortable(sig, client.append(folder, raw, ['\\Seen']), drop);
    },
    async close() {
      await client.logout().catch(() => client.close());
    },
  };
}

export function createImapSmtpClients(options: ClientOptions = { plaintextLoopback: false }): MailClients {
  return { smtp: (s) => smtpClient(s, options), mailbox: mailboxClient };
}

/** Real SMTP (nodemailer) and IMAP (imapflow) clients; TLS is always required. */
export const imapSmtpClients: MailClients = createImapSmtpClients();
