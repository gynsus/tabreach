import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { redactDeep, type Logger } from '@tabreach/protocol';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 5;
const ROTATION_CHECK_MS = 60_000;

/** Size-based rotation: name.log -> name.1.log ... name.<keep>.log. Returns true if it rotated. */
export function rotateLog(file: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP): boolean {
  if (!existsSync(file) || statSync(file).size < maxBytes) return false;
  const base = file.replace(/\.log$/, '');
  rmSync(`${base}.${keep}.log`, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    if (existsSync(`${base}.${i}.log`)) renameSync(`${base}.${i}.log`, `${base}.${i + 1}.log`);
  }
  renameSync(file, `${base}.1.log`);
  return true;
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
  const destination = pino.destination({ dest: file, sync: false });
  // A process can run for days: rotate while running, not only at start.
  setInterval(() => {
    if (rotateLog(file)) destination.reopen();
  }, ROTATION_CHECK_MS).unref();
  const streams: pino.StreamEntry[] = [{ stream: destination }];
  if (opts.stdout) streams.push({ stream: process.stdout });
  return createPinoLogger(opts.process, pino.multistream(streams), opts.level ?? 'info');
}

/**
 * Every log object passes through the shared redaction (docs/20-OBSERVABILITY.md): credential keys
 * in any casing/separator style at any depth, token-looking strings, and error messages/stacks.
 */
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
      serializers: { err: (err: unknown) => redactDeep(pino.stdSerializers.err(err as Error)) },
      formatters: { log: (obj) => redactDeep(obj) as Record<string, unknown> },
    },
    stream,
  );
}
