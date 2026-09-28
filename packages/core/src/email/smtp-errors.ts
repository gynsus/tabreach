import type { SendResult } from '../channels/channel.js';

interface SmtpError {
  code?: string;
  responseCode?: number;
  /** Set by our SMTP client: how far the attempt got. */
  stage?: 'connect' | 'auth' | 'submit';
}

/**
 * Maps an SMTP failure to a ledger outcome (ADR 018). Nothing was handed over when the failure
 * happened while connecting or logging in, or when the server explicitly refused the message. A
 * connection lost or timed out while submitting is \`unknown\`: the server may have accepted it.
 */
export function classifySmtpError(error: unknown): Exclude<SendResult, { outcome: 'completed' }> {
  const e = (error ?? {}) as SmtpError;
  const code = e.responseCode;
  if (e.code === 'EAUTH' || e.code === 'ENOAUTH' || e.code === 'EOAUTH2') {
    return { outcome: 'not_sent', errorClass: 'auth_failed' };
  }
  if (e.stage === 'connect' || e.stage === 'auth') {
    return { outcome: 'not_sent', errorClass: e.code === 'ETLS' ? 'smtp_tls' : 'smtp_connection' };
  }
  if (typeof code === 'number' && code >= 400) {
    // The server answered with a refusal: the message was not accepted.
    const recipient = e.code === 'EENVELOPE' && code >= 500;
    return {
      outcome: 'not_sent',
      errorClass: recipient ? 'recipient_rejected' : code >= 500 ? 'smtp_rejected' : 'smtp_deferred',
      permanent: recipient,
    };
  }
  if (e.code === 'EENVELOPE') return { outcome: 'not_sent', errorClass: 'smtp_envelope' };
  return { outcome: 'unknown', errorClass: 'smtp_no_confirmation' };
}
