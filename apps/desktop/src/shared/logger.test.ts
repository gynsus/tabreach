import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinoLogger, rotateLog } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
}

describe('log redaction', () => {
  it('never writes secret values at any supported depth', () => {
    const { lines, stream } = capture();
    const log = createPinoLogger('test', stream);
    log.info({
      apiKey: 'sk-ant-live-1',
      refreshToken: '1//refresh-2',
      request: { authorization: 'Bearer abc-3', body: { password: 'hunter2-4' } },
      secret: { plaintext: 'plain-5' },
      harmless: 'visible',
    });
    const out = lines.join('');
    for (const value of ['sk-ant-live-1', '1//refresh-2', 'Bearer abc-3', 'hunter2-4', 'plain-5']) {
      expect(out).not.toContain(value);
    }
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('visible');
  });

  it('redacts snake_case OAuth fields, headers, deep keys and token-looking strings', () => {
    const { lines, stream } = capture();
    createPinoLogger('test', stream).error(
      {
        oauth: { access_token: 'ya29.secretaccess123', refresh_token: 'r-7', client_secret: 'cs-8' },
        err: Object.assign(new Error('failed with Bearer abcdefghij.klm'), {
          response: { headers: { Authorization: 'Bearer zzzzzzzzzz', 'Set-Cookie': 'sid=9' } },
        }),
        a: { b: { c: { d: { e: { password: 'deep-10' } } } } },
        usage: { outputTokens: 42 },
      },
      'call failed',
    );
    const out = lines.join('');
    for (const v of [
      'ya29.secretaccess123',
      'r-7',
      'cs-8',
      'abcdefghij.klm',
      'zzzzzzzzzz',
      'sid=9',
      'deep-10',
    ]) {
      expect(out).not.toContain(v);
    }
    expect(out).toContain('"outputTokens":42');
  });

  it('redacts in child loggers too', () => {
    const { lines, stream } = capture();
    createPinoLogger('test', stream).child({ channel: 'host' }).warn({ token: 't-6' }, 'x');
    expect(lines.join('')).not.toContain('t-6');
  });
});

describe('rotateLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tabreach-logs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('shifts files and drops the oldest once the size cap is reached', () => {
    const file = join(dir, 'core.log');
    writeFileSync(join(dir, 'core.1.log'), 'older');
    writeFileSync(join(dir, 'core.2.log'), 'oldest');
    writeFileSync(file, 'x'.repeat(20));
    expect(rotateLog(file, 10, 2)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(join(dir, 'core.1.log'), 'utf8')).toBe('x'.repeat(20));
    expect(readFileSync(join(dir, 'core.2.log'), 'utf8')).toBe('older');
  });

  it('leaves small files alone', () => {
    const file = join(dir, 'main.log');
    writeFileSync(file, 'small');
    rotateLog(file, 10, 2);
    expect(readFileSync(file, 'utf8')).toBe('small');
  });
});
