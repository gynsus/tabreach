import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { errorSummary, type LaunchCheckResult, type Logger } from '@tabreach/protocol';

const PROFILE_PREFIX = 'tabreach-launch-check-';

export interface LaunchCheckOptions {
  /** `chrome` = the user's installed Google Chrome (default); `chromium` only for tests. */
  channel?: 'chrome' | 'chromium';
  /** Visible by default: the product never hides the browser (ADR 009). */
  headless?: boolean;
  timeoutMs?: number;
  /** Aborts the check: Chrome is closed and the result is `ok: false` (CLAUDE.md §5). */
  signal?: AbortSignal;
  logger: Logger;
}

/**
 * Phase 0 health probe (ADR 012): launch Chrome with a throwaway persistent profile,
 * load a page, read its title, close. Uses the same launch path real profiles will use.
 */
export async function launchCheck(url: string, opts: LaunchCheckOptions): Promise<LaunchCheckResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs * 2)])
    : AbortSignal.timeout(timeoutMs * 2);
  const profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
  const base = { url, httpStatus: null, title: null, chromeVersion: null } as const;

  try {
    signal.throwIfAborted();
    const context = await chromium.launchPersistentContext(profileDir, {
      ...(opts.channel === 'chromium' ? {} : { channel: 'chrome' }),
      headless: opts.headless ?? false,
      timeout: timeoutMs,
    });
    const abort = () => void context.close();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      return {
        ok: response !== null && response.ok(),
        url,
        httpStatus: response?.status() ?? null,
        title: await page.title(),
        chromeVersion: context.browser()?.version() ?? null,
        durationMs: Date.now() - started,
      };
    } finally {
      signal.removeEventListener('abort', abort);
      await context.close();
    }
  } catch (error) {
    const message = signal.aborted
      ? 'Aborted'
      : error instanceof Error
        ? (error.message.split('\n')[0] ?? error.name)
        : String(error);
    // Host only: later these URLs are people's profiles, which do not belong in logs.
    opts.logger.warn(
      { event: 'browser.launch_check_failed', host: hostOf(url), err: errorSummary(error) },
      'launch check failed',
    );
    return { ...base, ok: false, durationMs: Date.now() - started, error: message.slice(0, 300) };
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}

/**
 * Removes throwaway profiles left behind when a worker was killed mid-check. Called at worker
 * start; only this app creates directories with this prefix.
 */
export async function sweepStaleProfiles(dir: string = tmpdir()): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true });
  const stale = entries.filter((e) => e.isDirectory() && e.name.startsWith(PROFILE_PREFIX));
  await Promise.all(stale.map((e) => rm(join(dir, e.name), { recursive: true, force: true })));
  return stale.length;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}
