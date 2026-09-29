import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundledPack,
  matchState,
  type AdapterPack,
  type Control,
  type PageProbe,
  type PageState,
} from '@tabreach/adapter-packs';
import type {
  BrowserExecutionMode,
  TargetIdentity,
  TaskDiagnostics,
  TaskResult,
  ThreadReadResult,
} from '@tabreach/protocol';
import type { Page } from 'playwright-core';
import { safeUrl } from './profiles.js';

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
    // A page navigating under the probe throws; it is probed again on the next poll.
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
  /** Other known states: once the page settles in one of them, it is reported at once. */
  others: PageState[] = [],
): Promise<PageState | null> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    // A page navigating under the probe throws; it is probed again on the next poll.
    const state = await matchState(states, probeOf(page)).catch(() => null);
    if (state) return state;
    if (others.length > 0 && Date.now() - started > SETTLE_OTHERS_MS) {
      const other = await matchState(others, probeOf(page)).catch(() => null);
      if (other) return other;
    }
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(POLL_MS);
  }
}

/** How long a page may take to become an expected state before a known other one counts. */
const SETTLE_OTHERS_MS = 3_000;

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
    identity?: TargetIdentity | undefined;
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
  const logins = pack.states.filter((st) => st.kind === 'login');
  const start = await recognize(
    page,
    [...challenges, ...logins, ...byId(action.from)],
    RECOGNIZE_TIMEOUT_MS,
    signal,
    pack.states,
  );
  if (start?.kind === 'login') {
    return notCommitted({ stateId: start.id, stateKind: 'login', errorKey: 'task.loginRequired' });
  }
  if (!start || start.kind === 'challenge') {
    if (start) await page.bringToFront();
    return notCommitted({
      status: start ? 'needs_human' : 'unsupported_state',
      stateId: start?.id ?? null,
      stateKind: start?.kind ?? null,
      diagnostics: start ? null : await diagnose(page, req.taskId, action.from, env),
    });
  }
  // A known page, but not one this action starts from (an invitation already pending, say):
  // reported as what it is, and nothing is clicked.
  if (!action.from.includes(start.id)) {
    return notCommitted({ status: 'unsupported_state', stateId: start.id, stateKind: start.kind });
  }
  // The page must be about the intended person before anything is clicked (FR-LIN-003).
  if (action.identity) {
    if (!req.identity || !pack.identity) return notCommitted({ errorKey: 'task.identityRequired' });
    if (!(await identityMatches(page, pack.identity, req.identity))) {
      return notCommitted({
        status: 'unsupported_state',
        stateId: start.id,
        errorKey: 'task.identityMismatch',
      });
    }
  }
  // Non-critical clicks that lead to the action (open a dialog, "Add a note"), each landing in an
  // expected state, or nothing more happens.
  let at = start;
  for (const step of action.steps) {
    signal.throwIfAborted();
    const control = await findControl(page, step.click);
    if (!control) {
      return notCommitted({
        status: 'unsupported_state',
        stateId: at.id,
        diagnostics: await diagnose(page, req.taskId, step.expect, env),
      });
    }
    await control.click({ timeout: 10_000 });
    const next = await recognize(page, [...challenges, ...byId(step.expect)], RECOGNIZE_TIMEOUT_MS, signal);
    if (!next || next.kind === 'challenge') {
      if (next) await page.bringToFront();
      return notCommitted({
        status: next ? 'needs_human' : 'unsupported_state',
        stateId: next?.id ?? at.id,
        stateKind: next?.kind ?? null,
        diagnostics: next ? null : await diagnose(page, req.taskId, step.expect, env),
      });
    }
    at = next;
  }

  for (const field of action.fill) {
    const value = req.params[field.param];
    const control = await findControl(page, field.control);
    if (value === undefined || !control) {
      return notCommitted({
        status: 'unsupported_state',
        stateId: at.id,
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

  // The press goes to this very element, and only while the page is still the recognized one
  // (CLAUDE.md §3.5 "verify target identity"): a page that moved on is never clicked blindly.
  const startUrl = page.url();
  const handle = await commit.elementHandle({ timeout: 5_000 }).catch(() => null);
  if (!handle) return notCommitted({ errorKey: 'task.stateChanged' });
  const where = action.steps.at(-1)?.expect ?? action.from;
  const stillThere = async () =>
    page.url() === startUrl &&
    (await handle.evaluate((el) => el.isConnected).catch(() => false)) &&
    (await matchState(byId(where), probeOf(page)).catch(() => null))?.id === at.id &&
    (!action.identity ||
      !pack.identity ||
      !req.identity ||
      (await identityMatches(page, pack.identity, req.identity)));
  if (!(await stillThere())) return notCommitted({ errorKey: 'task.stateChanged' });

  signal.throwIfAborted();
  if (!(await checkpoint())) return notCommitted({ errorKey: 'task.checkpointRefused' });
  // Auto: checked once more after core's answer; not pressed is still a verified "not sent".
  if (req.mode === 'auto' && !(await stillThere())) return notCommitted({ errorKey: 'task.stateChanged' });
  // From here on the action may have happened: every way out says so.
  const committed = { ...base, url: page.url(), errorKey: null, committed: true } as const;
  try {
    let waitMs = VERIFY_TIMEOUT_MS;
    if (req.mode === 'auto') {
      signal.throwIfAborted();
      await handle.click({ timeout: 10_000 });
    } else {
      // Assisted: the person reviews and presses it (docs/07); focus shows them where.
      await page.bringToFront();
      await handle.focus().catch(() => {}); // only a pointer for the person
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
    // What was typed into the page is not evidence of a failure: fields are masked (audit 5.5).
    await page.screenshot({
      path: join(env.diagnosticsDir, screenshot),
      timeout: 10_000,
      mask: [page.locator('input, textarea, select, [contenteditable]:not([contenteditable="false"])')],
    });
  } catch {
    screenshot = null; // the snapshot below is still useful without it
  }
  const snapshot = await page
    .locator('body')
    .ariaSnapshot({ timeout: 10_000 })
    .catch(() => '');
  return {
    title: await page.title().catch(() => null),
    url: safeUrl(page.url()),
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
      /^\s*- (textbox|searchbox|combobox|spinbutton|slider)\b/.test(line)
        ? line.replace(/(:\s).*$/, '$1[value]')
        : // Link targets keep their path; queries and fragments may carry tokens.
          line.replace(
            /^(\s*- \/url: )(.*)$/,
            (_m, prefix: string, url: string) => prefix + url.replace(/[?#].*$/, ''),
          ),
    )
    .join('\n');
}

/** Diagnostics are kept for this long, then removed (audit 5.5): they may show personal data. */
export const DIAGNOSTICS_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** Removes old diagnostics and keeps the folder private to the user. */
export async function pruneDiagnostics(dir: string, now = Date.now()): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  await chmod(dir, 0o700).catch(() => {}); // absent until the first failure
  let removed = 0;
  for (const name of names) {
    const file = join(dir, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > DIAGNOSTICS_RETENTION_MS) {
      await rm(file, { force: true });
      removed++;
    }
  }
  return removed;
}

/** Lower case, without accents, spaces collapsed: "Ánn  Lee" ~ "ann lee". */
export function normalizeName(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The profile slug after the pack's profile path: `/in/ann-lee/` → `ann-lee`. */
export function profileSlug(url: string, profilePath: string): string | null {
  try {
    const path = decodeURIComponent(new URL(url).pathname).toLowerCase();
    const at = path.indexOf(profilePath);
    if (at === -1) return null;
    return path.slice(at + profilePath.length).split('/')[0] || null;
  } catch {
    return null;
  }
}

/** FR-LIN-003: the page's profile path and the name in its heading are the intended person's. */
export async function identityMatches(
  page: Page,
  rule: NonNullable<AdapterPack['identity']>,
  expected: TargetIdentity,
): Promise<boolean> {
  const slug = profileSlug(page.url(), rule.profilePath);
  if (!slug || slug !== profileSlug(expected.profileUrl, rule.profilePath)) return false;
  const headings = page.getByRole(rule.name.role as Parameters<Page['getByRole']>[0], {
    ...(rule.name.level ? { level: rule.name.level } : {}),
  });
  if ((await headings.count()) < 1) return false;
  const shown = normalizeName(
    (await headings
      .first()
      .textContent({ timeout: 5_000 })
      .catch(() => '')) ?? '',
  );
  const want = normalizeName(expected.name);
  // A heading may add a pronoun or a badge after the name; it never starts with someone else's.
  return shown === want || shown.startsWith(`${want} `);
}

/**
 * Reads a conversation (FR-LIN-004): opens it with the reader's steps (clicks that send nothing)
 * and lists the directions of its messages. `replied`: an inbound message after our last one.
 */
export async function readThread(
  page: Page,
  req: { taskId: string; packId: string; url: string; readerId: string; identity: TargetIdentity },
  env: TaskEnvironment,
  signal: AbortSignal,
): Promise<ThreadReadResult> {
  const pack = env.pack(req.packId);
  const reader = pack?.readers.find((r) => r.id === req.readerId);
  const base: Omit<ThreadReadResult, 'status'> = {
    messages: [],
    replied: false,
    stateId: null,
    packVersion: pack?.version ?? 'none',
    errorKey: null,
    diagnostics: null,
  };
  if (!pack || !reader) return { ...base, status: 'failed', errorKey: 'task.unknownAction' };
  const byId = (ids: string[]) => pack.states.filter((st) => ids.includes(st.id));
  const challenges = [...(env.pack('generic')?.states ?? []), ...pack.states].filter(
    (st) => st.kind === 'challenge',
  );
  const logins = pack.states.filter((st) => st.kind === 'login');
  try {
    await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return { ...base, status: 'failed', errorKey: 'task.navigationFailed' };
  }
  let at = await recognize(
    page,
    [...challenges, ...logins, ...byId(reader.from)],
    RECOGNIZE_TIMEOUT_MS,
    signal,
    pack.states,
  );
  if (at?.kind === 'login')
    return { ...base, status: 'failed', stateId: at.id, errorKey: 'task.loginRequired' };
  if (!at || at.kind === 'challenge') {
    return {
      ...base,
      status: at ? 'needs_human' : 'unsupported_state',
      stateId: at?.id ?? null,
      diagnostics: at ? null : await diagnose(page, req.taskId, reader.from, env),
    };
  }
  if (!reader.from.includes(at.id)) return { ...base, status: 'unsupported_state', stateId: at.id };
  if (reader.identity && (!pack.identity || !(await identityMatches(page, pack.identity, req.identity)))) {
    return { ...base, status: 'unsupported_state', stateId: at.id, errorKey: 'task.identityMismatch' };
  }
  for (const step of reader.steps) {
    signal.throwIfAborted();
    const control = await findControl(page, step.click);
    if (!control) {
      return {
        ...base,
        status: 'unsupported_state',
        stateId: at.id,
        diagnostics: await diagnose(page, req.taskId, step.expect, env),
      };
    }
    await control.click({ timeout: 10_000 });
    const next = await recognize(page, [...challenges, ...byId(step.expect)], RECOGNIZE_TIMEOUT_MS, signal);
    if (!next || next.kind === 'challenge') {
      return {
        ...base,
        status: next ? 'needs_human' : 'unsupported_state',
        stateId: next?.id ?? at.id,
        diagnostics: next ? null : await diagnose(page, req.taskId, step.expect, env),
      };
    }
    at = next;
  }
  const list = await findControl(page, reader.list);
  if (!list) {
    // No conversation yet is an empty thread only when the page says so by having no list; the
    // reader does not guess: an unrecognized page is unsupported.
    return {
      ...base,
      status: 'unsupported_state',
      stateId: at.id,
      diagnostics: await diagnose(page, req.taskId, [reader.id], env),
    };
  }
  const items = list.getByRole(reader.item as Parameters<Page['getByRole']>[0]);
  const count = Math.min(await items.count(), 500);
  const messages: { direction: 'in' | 'out' }[] = [];
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const label = (
      (await item.getAttribute('aria-label').catch(() => null)) ??
      (await item.textContent({ timeout: 5_000 }).catch(() => '')) ??
      ''
    ).toLowerCase();
    messages.push({ direction: reader.outgoingAny.some((p) => label.includes(p)) ? 'out' : 'in' });
  }
  const lastOut = messages.map((m) => m.direction).lastIndexOf('out');
  const replied = messages.some((m, i) => m.direction === 'in' && i > lastOut);
  return { ...base, status: 'ok', stateId: at.id, messages, replied };
}
