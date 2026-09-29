import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundledPack,
  matchState,
  type AdapterPack,
  type Control,
  type PageProbe,
  type PageState,
} from '@tabreach/adapter-packs';
import type { BrowserExecutionMode, TaskDiagnostics, TaskResult } from '@tabreach/protocol';
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
  const base = { packVersion, stateId: null, stateKind: null, diagnostics: null, committed: false } as const;
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

const VERIFY_TIMEOUT_MS = 15_000;
/** How long the person has to press the control in assisted mode. */
export const ASSISTED_WAIT_MS = 10 * 60_000;

/** Polls until one of `states` matches, or the deadline passes. */
async function recognize(
  page: Page,
  states: PageState[],
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PageState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const state = await matchState(states, probeOf(page)).catch(() => null);
    if (state) return state;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(POLL_MS);
  }
}

/** Exactly one visible control with one of the names; otherwise nothing (no guessing — docs/07). */
async function findControl(page: Page, control: Control) {
  for (const name of control.nameAny) {
    const found = page
      .getByRole(control.role as Parameters<Page['getByRole']>[0], { name, exact: true })
      .filter({ visible: true });
    const count = await found.count();
    if (count === 1) return found;
    if (count > 1) return null;
  }
  return null;
}

/**
 * commit (Phase 5c, docs/07 "Checkpoint rule"): from a recognized state, fill the action's fields,
 * ask core at the `about_to_commit` checkpoint, press the commit control once (or let the person
 * press it), then recognize the result. After the press nothing is retried here: a result that is
 * not a known success or rejection is `unknown`.
 */
export async function runCommit(
  page: Page,
  req: {
    taskId: string;
    packId: string;
    url: string;
    actionId?: string | undefined;
    params: Record<string, string>;
    mode: BrowserExecutionMode;
  },
  env: TaskEnvironment,
  signal: AbortSignal,
  /** Resolves true once core has recorded "executing"; false means do not press. */
  checkpoint: () => Promise<boolean>,
): Promise<TaskResult> {
  const pack = env.pack(req.packId);
  const packVersion = pack?.version ?? 'none';
  const base = { packVersion, stateId: null, stateKind: null, diagnostics: null } as const;
  const action = pack?.actions.find((a) => a.id === req.actionId);
  if (!pack || !action) {
    return { ...base, status: 'failed', url: null, errorKey: 'task.unknownAction', committed: false };
  }
  const byId = (ids: string[]) => pack.states.filter((st) => ids.includes(st.id));
  const challenges = [...(env.pack('generic')?.states ?? []), ...pack.states].filter(
    (st) => st.kind === 'challenge',
  );
  const notCommitted = (over: Partial<TaskResult>): TaskResult => ({
    ...base,
    status: 'failed',
    url: page.url(),
    errorKey: null,
    committed: false,
    ...over,
  });

  try {
    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return notCommitted({ errorKey: 'task.navigationFailed' });
  }
  const start = await recognize(page, [...challenges, ...byId(action.from)], RECOGNIZE_TIMEOUT_MS, signal);
  if (!start || start.kind === 'challenge') {
    if (start) await page.bringToFront();
    return notCommitted({
      status: start ? 'needs_human' : 'unsupported_state',
      stateId: start?.id ?? null,
      stateKind: start?.kind ?? null,
      diagnostics: start ? null : await diagnose(page, req.taskId, action.from, env),
    });
  }

  for (const field of action.fill) {
    const value = req.params[field.param];
    const control = await findControl(page, field.control);
    if (value === undefined || !control) {
      return notCommitted({
        status: 'unsupported_state',
        stateId: start.id,
        diagnostics: await diagnose(page, req.taskId, action.from, env),
      });
    }
    await control.fill(value);
    if ((await control.inputValue()) !== value) return notCommitted({ errorKey: 'task.fillFailed' });
  }
  const commit = await findControl(page, action.commit);
  if (!commit) {
    return notCommitted({
      status: 'unsupported_state',
      stateId: start.id,
      diagnostics: await diagnose(page, req.taskId, action.from, env),
    });
  }

  signal.throwIfAborted();
  if (!(await checkpoint())) return notCommitted({ errorKey: 'task.checkpointRefused' });
  // From here on the action may have happened: every way out says so.
  const committed = { ...base, url: page.url(), errorKey: null, committed: true } as const;
  try {
    let waitMs = VERIFY_TIMEOUT_MS;
    if (req.mode === 'auto') {
      signal.throwIfAborted();
      await commit.click({ timeout: 10_000 });
    } else {
      // Assisted: the person reviews and presses it (docs/07); focus shows them where.
      await page.bringToFront();
      await commit.focus().catch(() => {});
      waitMs = ASSISTED_WAIT_MS;
    }
    const after = await recognize(page, [...byId(action.success), ...byId(action.rejected)], waitMs, signal);
    if (after && action.success.includes(after.id)) {
      return { ...committed, status: 'succeeded', stateId: after.id, stateKind: after.kind, url: page.url() };
    }
    if (after) {
      // The site refused it on the spot: verified that nothing was sent.
      return {
        ...committed,
        status: 'failed',
        stateId: after.id,
        stateKind: after.kind,
        url: page.url(),
        errorKey: 'task.rejected',
      };
    }
  } catch {
    // Taken over, stopped, or the page broke after the checkpoint: it may have happened.
    return {
      ...committed,
      status: 'unknown',
      url: page.url(),
      errorKey: signal.aborted ? 'task.controlTaken' : 'task.verifyFailed',
    };
  }
  return {
    ...committed,
    status: 'unknown',
    url: page.url(),
    diagnostics: await diagnose(page, req.taskId, [...action.success, ...action.rejected], env).catch(
      () => null,
    ),
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
