import { describe, expect, it } from 'vitest';
import { isSensitiveKey, redactDeep, scrubString } from './redact.js';

describe('redaction', () => {
  it('recognizes credential keys in any casing or separator style', () => {
    for (const k of [
      'password',
      'access_token',
      'refresh_token',
      'id_token',
      'client_secret',
      'clientSecret',
      'X-Api-Key',
      'apiKey',
      'Authorization',
      'Set-Cookie',
      'sessionToken',
      'plaintext',
    ]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
  });

  it('keeps token counts and ordinary fields visible', () => {
    for (const k of ['inputTokens', 'outputTokens', 'maxTokens', 'email', 'fields', 'domain']) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });

  it('redacts at any depth and fails closed past the depth limit', () => {
    const out = redactDeep(
      { a: { b: { c: { d: { refresh_token: 'x' } } } }, deep: { l1: { l2: { l3: 'v' } } } },
      4,
    ) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain('"x"');
    expect(JSON.stringify(out)).toContain('[TRUNCATED]');
  });

  it('scrubs token-looking values inside strings and errors', () => {
    expect(scrubString('Authorization: Bearer abc.def.ghijklmnop')).toBe('Authorization: [REDACTED]');
    expect(scrubString('key sk-ant-api03-0123456789abcdef used')).toBe('key [REDACTED] used');
    const err = redactDeep(new Error('token ya29.a0AfH6SMBx123456 expired')) as { message: string };
    expect(err.message).toBe('token [REDACTED] expired');
  });
});
