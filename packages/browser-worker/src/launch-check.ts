import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { LaunchCheckResult, Logger } from '@tabreach/protocol';

export interface LaunchCheckOptions {
  /** `chrome` = the user's installed Google Chrome (default); `chromium` only for tests. */
  channel?: 'chrome' | 'chromium';
  /** Visible by default: the product never hides the browser (ADR 009). */
  headless?: boolean;
  timeoutMs?: number;
  logger: Logger;
}

/**
 * Phase 0 health probe (ADR 012): launch Chrome with a throwaway persistent profile,
 * load a page, read its title, close. Uses the same launch path real profiles will use.
 */
export async function launchCheck(url: string, opts: LaunchCheckOptions): Promise<LaunchCheckResult> {
  const started = Date.now();
  const profileDir = await mkdtemp(join(tmpdir(), 'tabreach-launch-check-'));
  const base = { url, httpStatus: null, title: null, chromeVersion: null } as const;

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      ...(opts.channel === 'chromium' ? {} : { channel: 'chrome' }),
      headless: opts.headless ?? false,
      timeout: opts.timeoutMs ?? 30_000,
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const response = await page.goto(url, { waitUntil: 'load', timeout: opts.timeoutMs ?? 30_000 });
      return {
        ok: response !== null && response.ok(),
        url,
        httpStatus: response?.status() ?? null,
        title: await page.title(),
        chromeVersion: context.browser()?.version() ?? null,
        durationMs: Date.now() - started,
      };
    } finally {
      await context.close();
    }
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : String(error);
    opts.logger.warn({ event: 'browser.launch_check_failed', url, err: error }, 'launch check failed');
    return { ...base, ok: false, durationMs: Date.now() - started, error: message.slice(0, 300) };
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
}
