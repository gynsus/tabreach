import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createImapSmtpClients } from './imap-smtp.js';
import { composeMessage } from './mime.js';
import { classifySmtpError } from './smtp-errors.js';
import type { MailSettings } from './transport.js';

type Mode = 'accept' | 'drop_after_data' | 'reject_rcpt' | 'reject_data';

/** A local SMTP server on a random port (no TLS, AUTH PLAIN/LOGIN), behaving as told. */
async function startServer(mode: Mode) {
  const received: string[] = [];
  const server = new SMTPServer({
    secure: false,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN'],
    logger: false,
    onAuth(auth, _session, callback) {
      if (auth.username === 'me' && auth.password === 'secret') callback(null, { user: 'me' });
      else callback(Object.assign(new Error('Invalid login'), { responseCode: 535 }));
    },
    onRcptTo(_address, _session, callback) {
      if (mode === 'reject_rcpt') callback(Object.assign(new Error('No such user'), { responseCode: 550 }));
      else callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        if (mode === 'drop_after_data') {
          // The message arrived, but the answer never does: the client cannot know.
          (session as unknown as { socket?: { destroy(): void } }).socket?.destroy();
          (server as unknown as { connections: Set<{ _socket: { destroy(): void } }> }).connections.forEach(
            (c) => c._socket.destroy(),
          );
          return;
        }
        if (mode === 'reject_data') callback(Object.assign(new Error('Spam'), { responseCode: 554 }));
        else callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { server, port, received, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const settings = (port: number, password = 'secret'): MailSettings => ({
  address: 'me@acme.test',
  username: 'me',
  password,
  smtp: { host: '127.0.0.1', port, security: 'starttls' },
  imap: { host: '127.0.0.1', port: 1, security: 'tls' },
});

async function send(port: number, password?: string) {
  const smtp = createImapSmtpClients({ plaintextLoopback: true }).smtp(settings(port, password));
  const raw = await composeMessage({
    from: { address: 'me@acme.test', name: null },
    to: { address: 'bob@beta.test', name: null },
    subject: 'Hi',
    body: 'Hello',
    messageId: '<m-1@acme.test>',
    date: new Date(),
  });
  try {
    return await smtp.send(raw, { from: 'me@acme.test', to: 'bob@beta.test' }, AbortSignal.timeout(10_000));
  } finally {
    smtp.close();
  }
}

describe('SMTP through nodemailer against a local server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('submits the message with our Message-ID', async () => {
    const s = await startServer('accept');
    close = s.close;
    const result = await send(s.port);
    expect(result.response).toMatch(/^250/);
    expect(s.received[0]).toMatch(/^Message-ID: <m-1@acme\.test>$/m);
  });

  it('a wrong password is not sent (auth_failed)', async () => {
    const s = await startServer('accept');
    close = s.close;
    const error = await send(s.port, 'wrong').catch((e: unknown) => e);
    expect(classifySmtpError(error)).toEqual({ outcome: 'not_sent', errorClass: 'auth_failed' });
    expect(s.received).toHaveLength(0);
  });

  it('a refused recipient is permanently not sent', async () => {
    const s = await startServer('reject_rcpt');
    close = s.close;
    const error = await send(s.port).catch((e: unknown) => e);
    expect(classifySmtpError(error)).toMatchObject({ outcome: 'not_sent', permanent: true });
  });

  it('a refused message is not sent', async () => {
    const s = await startServer('reject_data');
    close = s.close;
    const error = await send(s.port).catch((e: unknown) => e);
    expect(classifySmtpError(error)).toMatchObject({ outcome: 'not_sent', errorClass: 'smtp_rejected' });
  });

  it('a connection lost after the message was transmitted is unknown, not "not sent"', async () => {
    const s = await startServer('drop_after_data');
    close = s.close;
    const error = await send(s.port).catch((e: unknown) => e);
    expect(s.received).toHaveLength(1); // it did arrive
    expect(classifySmtpError(error)).toEqual({ outcome: 'unknown', errorClass: 'smtp_no_confirmation' });
  });

  it('nobody listening is not sent', async () => {
    const error = await send(1).catch((e: unknown) => e);
    expect(classifySmtpError(error)).toMatchObject({ outcome: 'not_sent', errorClass: 'smtp_connection' });
  });
});
