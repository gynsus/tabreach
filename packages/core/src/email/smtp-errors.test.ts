import { describe, expect, it } from 'vitest';
import { classifySmtpError } from './smtp-errors.js';

describe('classifySmtpError', () => {
  it('treats failures while connecting or logging in as not sent', () => {
    expect(classifySmtpError({ code: 'ECONNECTION', stage: 'connect' })).toEqual({
      outcome: 'not_sent',
      errorClass: 'smtp_connection',
    });
    expect(classifySmtpError({ code: 'ETIMEDOUT', stage: 'auth' })).toMatchObject({ outcome: 'not_sent' });
    expect(classifySmtpError({ code: 'EAUTH', stage: 'auth', responseCode: 535 })).toEqual({
      outcome: 'not_sent',
      errorClass: 'auth_failed',
    });
  });

  it('treats an explicit refusal as not sent; a refused recipient is permanent', () => {
    expect(classifySmtpError({ code: 'EENVELOPE', stage: 'submit', responseCode: 550 })).toEqual({
      outcome: 'not_sent',
      errorClass: 'recipient_rejected',
      permanent: true,
    });
    expect(classifySmtpError({ code: 'EMESSAGE', stage: 'submit', responseCode: 554 })).toMatchObject({
      outcome: 'not_sent',
      permanent: false,
    });
    expect(classifySmtpError({ stage: 'submit', responseCode: 451 })).toMatchObject({
      errorClass: 'smtp_deferred',
    });
  });

  it('treats a connection lost while submitting as unknown, whatever nodemailer calls it', () => {
    expect(classifySmtpError({ code: 'ECONNECTION', stage: 'submit' })).toEqual({
      outcome: 'unknown',
      errorClass: 'smtp_no_confirmation',
    });
    expect(classifySmtpError({ code: 'ETIMEDOUT', stage: 'submit' })).toMatchObject({ outcome: 'unknown' });
    expect(classifySmtpError(new Error('anything else'))).toMatchObject({ outcome: 'unknown' });
  });
});
