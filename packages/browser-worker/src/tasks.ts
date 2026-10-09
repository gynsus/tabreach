import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bundledPack,
  matchState,
  type AdapterPack,
  type Control,
  type PackReader,
  type PackStep,
  type PageProbe,
  type PageState,
} from '@tabreach/adapter-packs';
import type {
  StepExecutionMode,
  TargetIdentity,
  TaskDiagnostics,
  TaskResult,
  ThreadReadResult,
} from '@tabreach/protocol';
import type { Locator, Page } from 'playwright-core';
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
    frameUrls: async () => {
      const shown: string[] = [];
      for (const frame of page.frames()) {
        if (frame === page.mainFrame() || /[?&]size=invisible\b/.test(frame.url())) continue;
        const element = await frame.frameElement().catch(() => null);
        const box = await element?.boundingBox().catch(() => null);
        if (box && box.width >= 50 && box.height >= 50) shown.push(frame.url());
      }
      return shown;
    },
    hasRole: async (role, { name, level, within }) =>
      (await byRole(page, within, role, { ...(name ? { name } : {}), ...(level ? { level } : {}) }).count()) >
      0,
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

/**
 * A page can be recognized before its scripts are ready: a click then does nothing (LinkedIn's
 * "Message" on a live profile, 2026-09-30). Steps wait for the load and a moment more.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {}); // a slow page is tried anyway
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * A non-critical step towards one of `expect`: a click (once — a click that did nothing is not
 * repeated), or `follow`: the link's address opened in this tab, same site only. A followed link
 * does not depend on what the site does with a click (LinkedIn's "Message" opens a floating
 * window, a new page or nothing — live check, 2026-09-30).
 */
async function performStep(
  page: Page,
  step: PackStep,
  expect: PageState[],
  signal: AbortSignal,
): Promise<PageState | null | 'missing'> {
  const target = step.click ?? step.follow;
  const control = target ? await findControl(page, target) : null;
  if (!control) return 'missing';
  if (step.click) {
    await control.click({ timeout: 10_000 });
  } else {
    const href = await control.getAttribute('href', { timeout: 5_000 }).catch(() => null);
    const here = new URL(page.url());
    const to = href ? new URL(href, here) : null;
    if (!to || to.origin !== here.origin) return 'missing';
    await page.goto(to.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }
  return recognize(page, expect, RECOGNIZE_TIMEOUT_MS, signal);
}

const SETTLE_MS = 1_500;

/**
 * What a filled control holds: the value of a field, or the text of an editable element (LinkedIn's
 * composer is a contenteditable `div`, live check 2026-10-09), compared without whitespace runs.
 */
async function typedText(control: Locator): Promise<string | null> {
  const text = await control
    .evaluate((el) => {
      const e = el as unknown as { value?: unknown; innerText?: string };
      return typeof e.value === 'string' ? e.value : (e.innerText ?? '');
    })
    .catch(() => null);
  return text === null ? null : normalizeText(text);
}

const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();

type AriaRole = Parameters<Page['getByRole']>[0];

/**
 * Elements with a role (from validated pack data; Playwright checks it against ARIA), inside the
 * first `within` landmark when one is named — but not inside a complementary landmark nested in it:
 * LinkedIn's "More profiles for you", with other people's Connect and Message, is an `aside`
 * inside `main` (live check, 2026-10-09).
 */
function byRole(
  page: Page,
  within: string | undefined,
  role: string,
  options: Parameters<Page['getByRole']>[1] = {},
): Locator {
  if (!within) return page.getByRole(role as AriaRole, options);
  return page
    .getByRole(within as AriaRole)
    .first()
    .getByRole(role as AriaRole, options)
    .and(page.locator(':not(aside *, [role="complementary"] *)'));
}

/** The little of the DOM that in-page reads use (the worker is compiled without DOM types). */
interface QueryRoot {
  querySelectorAll(selector: string): ArrayLike<QueryRoot> & Iterable<QueryRoot>;
  getAttribute(name: string): string | null;
  textContent: string | null;
}

/**
 * Exactly one visible control with one of the names (or, with no names, the only one with its
 * role), inside its landmark when it names one; otherwise nothing (no guessing — docs/07).
 */
async function findControl(page: Page, control: Control) {
  if (!control.nameAny) {
    const found = byRole(page, control.within, control.role).filter({ visible: true });
    return (await found.count()) === 1 ? found : null;
  }
  for (const name of control.nameAny) {
    const found = byRole(page, control.within, control.role, {
      name,
      exact: !control.nameContains,
    }).filter({ visible: true });
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
    mode: StepExecutionMode;
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
  if (action.steps.length > 0) await settle(page);
  for (const step of action.steps) {
    signal.throwIfAborted();
    const next = await performStep(page, step, [...challenges, ...byId(step.expect)], signal);
    if (next === 'missing') {
      return notCommitted({
        status: 'unsupported_state',
        stateId: at.id,
        diagnostics: await diagnose(page, req.taskId, step.expect, env),
      });
    }
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

  // Manual (ADR 015): the page is the person's from here — the text is shown in the overlay, not
  // typed, and nothing is pressed. Core records the checkpoint first (the last checks and
  // "executing"), so the person may send right away; what happened is theirs to say.
  if (req.mode === 'manual') {
    signal.throwIfAborted();
    if (!(await checkpoint())) return notCommitted({ errorKey: 'task.checkpointRefused' });
    await page.bringToFront();
    return {
      ...base,
      status: 'unknown',
      stateId: at.id,
      stateKind: at.kind,
      url: page.url(),
      errorKey: 'task.manual',
      committed: true,
    };
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
    if ((await typedText(control)) !== normalizeText(value))
      return notCommitted({ errorKey: 'task.fillFailed' });
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
  // On a profile the person is checked again; a page reached from it (the conversation a verified
  // profile's "Message" link leads to) is held to its exact address instead.
  const stillTheirs = async () =>
    !action.identity ||
    !pack.identity ||
    !req.identity ||
    !profileSlug(page.url(), pack.identity.profilePath) ||
    (await identityMatches(page, pack.identity, req.identity));
  const stillThere = async () =>
    page.url() === startUrl &&
    (await handle.evaluate((el) => el.isConnected).catch(() => false)) &&
    (await matchState(byId(where), probeOf(page)).catch(() => null))?.id === at.id &&
    (await stillTheirs());
  if (!(await stillThere())) return notCommitted({ errorKey: 'task.stateChanged' });

  // Actions no page confirms (a LinkedIn message) are proven by the reader: one more of ours.
  const confirmReader = action.confirm
    ? pack.readers.find((r) => r.id === action.confirm?.reader)
    : undefined;
  // The proof is our text as the last message, not a count: LinkedIn loads older messages into the
  // thread while it is open, which once looked like one more of ours (live check, 2026-10-09).
  const typed = normalizeText(
    action.fill
      .map((f) => req.params[f.param] ?? '')
      .filter(Boolean)
      .at(-1) ?? '',
  ).slice(0, 80);
  const lastIsOurs = async (): Promise<boolean | null> => {
    if (!confirmReader || !req.identity || !typed) return null;
    const items = await readThreadItems(page, confirmReader, req.identity.name);
    if (!items) return null;
    const last = items.at(-1);
    return last?.direction === 'out' && last.text.includes(typed);
  };
  // Already the last message (the same text a moment ago): a new one could not be told apart.
  if (action.confirm && (await lastIsOurs()) !== false) {
    return notCommitted({ errorKey: 'task.confirmUnavailable' });
  }

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
    if (action.confirm) {
      const deadline = Date.now() + waitMs;
      for (;;) {
        signal.throwIfAborted();
        if ((await lastIsOurs()) === true) {
          return { ...committed, status: 'succeeded', stateId: null, stateKind: null, url: page.url() };
        }
        if (Date.now() > deadline) break;
        await page.waitForTimeout(POLL_MS);
      }
      return { ...committed, status: 'unknown', url: page.url() };
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
  const headings = byRole(page, rule.name.within, rule.name.role, {
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
  if (reader.steps.length > 0) await settle(page);
  for (const step of reader.steps) {
    signal.throwIfAborted();
    const next = await performStep(page, step, [...challenges, ...byId(step.expect)], signal);
    if (next === 'missing') {
      return {
        ...base,
        status: 'unsupported_state',
        stateId: at.id,
        diagnostics: await diagnose(page, req.taskId, step.expect, env),
      };
    }
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
  const messages = await readMessages(page, reader, req.identity.name);
  if (!messages) {
    // No recognizable conversation where one should be: the reader does not guess.
    return {
      ...base,
      status: 'unsupported_state',
      stateId: at.id,
      diagnostics: await diagnose(page, req.taskId, [reader.id], env),
    };
  }
  const lastOut = messages.map((m) => m.direction).lastIndexOf('out');
  const replied = messages.some((m, i) => m.direction === 'in' && i > lastOut);
  return { ...base, status: 'ok', stateId: at.id, messages, replied };
}

/**
 * The directions of a conversation's messages (a pack reader): the list inside the reader's
 * container with the most items carrying a profile link (a list of conversations has none); an item's sender is a link naming the contact (theirs) or another profile
 * link (ours); an item without one continues the sender before it. null: no conversation found.
 */
export async function readMessages(
  page: Page,
  reader: PackReader,
  contactName: string,
): Promise<{ direction: 'in' | 'out' }[] | null> {
  return (await readThreadItems(page, reader, contactName))?.map(({ direction }) => ({ direction })) ?? null;
}

/**
 * The conversation's items with their text, for the worker only: the text proves that our own
 * message is the last one (a confirmation) and never leaves this process.
 */
async function readThreadItems(
  page: Page,
  reader: PackReader,
  contactName: string,
): Promise<{ direction: 'in' | 'out'; text: string }[] | null> {
  const container = await findControl(page, reader.within);
  if (!container) return null;
  // Each list's items: the labels of their links and their text, read in the page (the worker
  // has no DOM types).
  const lists = await container
    .getByRole('list')
    .evaluateAll((els) =>
      els.map((e) =>
        Array.from((e as unknown as QueryRoot).querySelectorAll(':scope > li')).map((li) => ({
          links: Array.from(li.querySelectorAll('a')).map((a) =>
            `${a.getAttribute('aria-label') ?? ''} ${a.textContent ?? ''}`.replace(/\s+/g, ' ').trim(),
          ),
          text: li.textContent ?? '',
        })),
      ),
    )
    .catch(() => null);
  if (!lists) return null;
  const words = reader.profileLinkAny;
  const them = normalizeName(contactName);
  const withSender = lists.map(
    (items) =>
      items.filter((item) => item.links.some((l) => words.some((w) => normalizeName(l).includes(w)))).length,
  );
  if (withSender.length === 0 || Math.max(...withSender) === 0) {
    // No list with a sender in it: a conversation not started yet — unless a list names the person
    // (their conversation among the others): then it is one this reader cannot read, and nothing
    // is written without knowing (fails closed).
    const named = lists.some((items) => items.some((item) => normalizeName(item.text).includes(them)));
    return named ? null : [];
  }
  const items = lists[withSender.indexOf(Math.max(...withSender))] ?? [];
  const messages: { direction: 'in' | 'out'; text: string }[] = [];
  let current: 'in' | 'out' | null = null;
  for (const item of items.slice(-500)) {
    const names = item.links.map(normalizeName);
    if (names.some((n) => n.includes(them))) current = 'in';
    else if (names.some((n) => reader.profileLinkAny.some((p) => n.includes(p)))) current = 'out';
    // Items before the first sender (a date line) belong to no one.
    if (current) messages.push({ direction: current, text: normalizeText(item.text) });
  }
  return messages;
}
