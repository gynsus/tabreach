import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import type { Logger } from '@tabreach/protocol';

/**
 * Keys whose values never reach a log file (docs/20-OBSERVABILITY.md). Paths cover the top level
 * and one or two levels of nesting, which is where structured log context puts them.
 */
const SENSITIVE_KEYS = [
  'password',
  'passphrase',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'apiKey',
  'clientSecret',
  'secret',
  'plaintext',
  'ciphertext',
  'cookie',
  'cookies',
  'authorization',
];
export const REDACT_PATHS = SENSITIVE_KEYS.flatMap((k) => [k, `*.${k}`, `*.*.${k}`]);

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;

/** Size-based rotation at process start: name.log -> name.1.log ... name.<keep>.log. */
export function rotateLog(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): void {
  if (!existsSync(file) || statSync(file).size < maxBytes) return;
  const base = file.replace(/\.log$/, '');
  rmSync(`${base}.${keep}.log`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${base}.${i}.log`)) renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`);
  }
  renameSync(file, `${base}.1.log`);
}

export interface LoggerOptions {
  process: 'main' | 'core' | 'worker';
  logDir: string;
  /** Mirror to stdout (development). */
  stdout?: boolean;
  level?: pino.Level;
}

export function createLogger(opts: LoggerOptions): Logger {
  mkdirSync(opts.logDir, { recursive: true });
  const file = join(opts.logDir, `${opts.process}.log`);
  rotateLog(file);
  const streams: pino.StreamEntry[] = [{ stream: pino.destination({ dest: file, sync: false }) }];
  if (opts.stdout) streams.push({ stream: process.stdout });
  return createPinoLogger(opts.process, pino.multistream(streams), opts.level ?? 'info');
}

export function createPinoLogger(
  processName: string,
  stream: pino.DestinationStream,
  level: pino.Level = 'info',
): Logger {
  return pino(
    {
      level,
      base: { process: processName, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { err: pino.stdSerializers.err },
    },
    stream,
  );
}
