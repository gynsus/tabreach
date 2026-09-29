import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { bundledPack, matchState, type AdapterPack, type PageProbe } from '@tabreach/adapter-packs';
import type { TaskDiagnostics, TaskResult } from '@tabreach/protocol';
import type { Page } from 'playwright-core';

const RECOGNIZE_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
const MAX_SNAPSHOT = 20_000;

export interface TaskEnvironment {
  /** Where screenshots of failures go (`<app data>/diagnostics`). */
  diagnosticsDir: string;
  /** Packs by id; bundled by default, fixtures in tests. */
  pack: (id: string) => AdapterPack | undefined;
}

export const bundledPacks = (id: string) => bundledPack(id);

/** A Playwright page as the pack matcher sees it: roles and visible text, never field values. */
export function probeOf(page: Page): PageProbe {
  return {
    url: page.url(),
    frameUrls: page.frames().map((f) => f.url()),
    hasRole: async (role, { name, level }) =>
      (await page
        // Roles come from validated pack data; Playwright checks them against ARIA.
        .getByRole(role as Parameters<Page['getByRole']>[0], {
          ...(name ? { name } : {}),
          ...(level ? { level } : {}),
        })
        .count()) > 0,
    hasText: async (text) => (await page.getByText(text).filter({ visible: true }).count()) > 0,
  };
}

/**
 * check_state (Phase 5b): open a page and recognize it against the pack's allowlist and the generic
 * challenge states. A challenge means a person; nothing recognized means `unsupported_state` with
 * diagnostics to update the pack (docs/19).
 */
export async function runCheckState(
  page: Page,
  req: { taskId: string; packId: string; url: string },
  env: TaskEnvironment,
  signal: AbortSignal,
): Promise<TaskResult> {
  const pack = env.pack(req.packId);
  const generic = env.pack('generic');
  const packVersion = pack?.version ?? 'none';
  const base = { packVersion, stateId: null, stateKind: null, diagnostics: null } as const;
  if (!pack) return { ...base, status: 'failed', url: null, errorKey: 'task.unknownPack' };
  const states = [...(generic?.states ?? []), ...pack.states];
  try {
    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return { ...base, status: 'failed', url: page.url(), errorKey: 'task.navigationFailed' };
  }
  const deadline = Date.now() + RECOGNIZE_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const state = await matchState(states, probeOf(page)).catch(() => null);
    if (state) {
      if (state.kind === 'challenge') await page.bringToFront();
      return {
        ...base,
        status: state.kind === 'challenge' ? 'needs_human' : 'succeeded',
        stateId: state.id,
        stateKind: state.kind,
        url: page.url(),
        errorKey: null,
      };
    }
    if (Date.now() > deadline) break;
    await page.waitForTimeout(POLL_MS);
  }
  return {
    ...base,
    status: 'unsupported_state',
    url: page.url(),
    diagnostics: await diagnose(
      page,
      req.taskId,
      states.map((s) => s.id),
      env,
    ),
    errorKey: null,
  };
}

/** Screenshot and a redacted accessibility snapshot (docs/07 "Diagnostics"). */
export async function diagnose(
  page: Page,
  taskId: string,
  expectedStates: string[],
  env: TaskEnvironment,
): Promise<TaskDiagnostics> {
  let screenshot: string | null = `${taskId}.png`;
  try {
    await mkdir(env.diagnosticsDir, { recursive: true, mode: 0o700 });
    await page.screenshot({ path: join(env.diagnosticsDir, screenshot), timeout: 10_000 });
  } catch {
    screenshot = null; // the snapshot below is still useful without it
  }
  const snapshot = await page
    .locator('body')
    .ariaSnapshot({ timeout: 10_000 })
    .catch(() => '');
  return {
    title: await page.title().catch(() => null),
    url: page.url(),
    screenshot,
    ariaSnapshot: redactSnapshot(snapshot).slice(0, MAX_SNAPSHOT),
    expectedStates,
  };
}

/** What people typed never leaves the page: values of text inputs are cut from the snapshot. */
export function redactSnapshot(snapshot: string): string {
  return snapshot
    .split('\n')
    .map((line) =>
      /^\s*- (textbox|searchbox|combobox|spinbutton)\b/.test(line)
        ? line.replace(/(:\s).*$/, '$1[value]')
        : line,
    )
    .join('\n');
}
