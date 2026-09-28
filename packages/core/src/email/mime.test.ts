import { describe, expect, it } from 'vitest';
import { composeMessage, messageIdFor } from './mime.js';

describe('mime', () => {
  it('derives a stable Message-ID on the sender domain', () => {
    const key = 'a'.repeat(64);
    expect(messageIdFor(key, 'me@acme.test')).toBe(`<${'a'.repeat(40)}@acme.test>`);
    expect(messageIdFor(key, 'me@acme.test')).toBe(messageIdFor(key, 'me@acme.test'));
  });

  it('composes a UTF-8 plain-text message with our Message-ID', async () => {
    const raw = (
      await composeMessage({
        from: { address: 'me@acme.test', name: 'Анна' },
        to: { address: 'bob@beta.test', name: 'Bob Lee' },
        subject: 'Привет',
        body: 'Строка 1\nLine 2',
        messageId: '<id-1@acme.test>',
        date: new Date('2026-09-28T10:00:00Z'),
      })
    ).toString('utf8');
    expect(raw).toMatch(/^Message-ID: <id-1@acme\.test>$/m);
    expect(raw).toMatch(/^To: Bob Lee <bob@beta\.test>$/m);
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).toMatch(/charset=utf-8/i);
    expect(raw).not.toMatch(/tabreach/i);
  });
});
