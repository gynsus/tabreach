import { createHash } from 'node:crypto';
import { matchState, type AdapterPack, type FormKnowledge } from '@tabreach/adapter-packs';
import {
  sameSite,
  type BrowserExecutionMode,
  type FormField,
  type FormFieldMeaning,
  type FormPrepareResult,
  type FormValues,
  type ResolveTargetRequest,
  type ResolveTargetResult,
  type TaskResult,
} from '@tabreach/protocol';
import type { ElementHandle, Page } from 'playwright-core';
import { safeUrl } from './profiles.js';
import { ASSISTED_WAIT_MS, diagnose, probeOf, type TaskEnvironment } from './tasks.js';

const FORM_WAIT_MS = 6_000;
const VERIFY_TIMEOUT_MS = 15_000;
const POLL_MS = 400;
const MAX_CANDIDATE_PAGES = 3;
const NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * The few DOM shapes the page scripts below use: the worker is compiled without DOM types (it
 * must not touch a DOM itself), and these functions run inside the page.
 */
interface DomEl {
  tagName: string;
  textContent: string | null;
  isConnected: boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number };
  querySelector(selector: string): DomEl | null;
}
interface DomField extends DomEl {
  name: string;
  id: string;
  value: string;
  required: boolean;
  labels: ArrayLike<DomEl> | null;
}
interface DomForm extends DomEl {
  elements: ArrayLike<DomField>;
  checkValidity(): boolean;
}
interface PageGlobals {
  document: { getElementById(id: string): DomEl | null };
  getComputedStyle(el: DomEl): { visibility: string; display: string };
}

/** A form element as the page describes it (read by a script; nothing is changed). */
interface RawField {
  ref: number;
  tag: string;
  type: string;
  name: string;
  id: string;
  autocomplete: string;
  placeholder: string;
  label: string;
  required: boolean;
  visible: boolean;
}
interface RawForm {
  visible: boolean;
  role: string;
  fields: RawField[];
}

/** Runs in the page: the form's fields with their labels, in `form.elements` order. */
const DESCRIBE_FORM = (node: unknown): RawForm => {
  const form = node as DomForm;
  const g = globalThis as unknown as PageGlobals;
  const text = (el: DomEl | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: DomEl) => {
    const r = el.getBoundingClientRect();
    const cs = g.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const labelOf = (el: DomField) => {
    const parts: string[] = [];
    for (const l of Array.from(el.labels ?? [])) parts.push(text(l));
    const aria = el.getAttribute('aria-label');
    if (aria) parts.push(aria);
    for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean))
      parts.push(text(g.document.getElementById(id)));
    return parts.join(' ').slice(0, 300);
  };
  const fields: RawField[] = [];
  Array.from(form.elements).forEach((el, ref) => {
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && ['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(type)) return;
    fields.push({
      ref,
      tag,
      type: tag === 'input' ? type || 'text' : tag,
      name: el.name ?? '',
      id: el.id ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
      label: labelOf(el),
      required: el.required || el.getAttribute('aria-required') === 'true',
      // A field nobody can see is a trap for bots (honeypot) or not in use: never filled.
      visible: visible(el),
    });
  });
  return { visible: visible(form), role: (form.getAttribute('role') ?? '').toLowerCase(), fields };
};

/** A contact form: something to write in, a way to be answered, and no password (not a login). */
function contactScore(form: RawForm): number {
  if (!form.visible || form.role === 'search') return 0;
  const shown = form.fields.filter((f) => f.visible);
  if (shown.some((f) => f.type === 'password' || f.type === 'search')) return 0;
  let score = 0;
  if (shown.some((f) => f.tag === 'textarea')) score += 3;
  if (shown.some((f) => f.type === 'email' || /mail|почт/i.test(`${f.name} ${f.label} ${f.placeholder}`)))
    score += 2;
  if (shown.length >= 3) score += 1;
  return score;
}

const AUTOCOMPLETE: Record<string, FormFieldMeaning> = {
  name: 'name',
  'given-name': 'firstName',
  'family-name': 'lastName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'company',
  url: 'website',
};
/** Most specific first: "company name" is a company, "last name" a last name, "name" a name. */
const ORDER: FormFieldMeaning[] = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'company',
  'website',
  'subject',
  'message',
  'name',
];

function kindOf(f: RawField): FormField['kind'] {
  if (f.tag === 'textarea') return 'textarea';
  if (f.tag === 'select') return 'select';
  if (['email', 'tel', 'url', 'checkbox', 'radio'].includes(f.type)) return f.type as FormField['kind'];
  return ['text', ''].includes(f.type) ? 'text' : 'other';
}

/** What a field means, from its autocomplete, type and words (pack phrases); null: not known. */
export function meaningOf(f: RawField, knowledge: FormKnowledge): FormFieldMeaning | null {
  const words =
    `${f.label} ${f.placeholder} ${f.name.replace(/[-_]/g, ' ')} ${f.id.replace(/[-_]/g, ' ')}`.toLowerCase();
  // A phrase counts from the start of a word: "lname" is not in "fullname", "политик" is in "политикой".
  const has = (meaning: FormFieldMeaning) => knowledge.fields[meaning].some((p) => startsWord(words, p));
  if (f.type === 'checkbox') return has('consent') ? 'consent' : null;
  if (f.type === 'radio' || f.tag === 'select') return null;
  const auto = AUTOCOMPLETE[f.autocomplete.toLowerCase().split(/\s+/).pop() ?? ''];
  if (auto) return auto;
  if (f.type === 'email') return 'email';
  if (f.type === 'tel') return 'phone';
  if (f.type === 'url') return 'website';
  for (const meaning of ORDER) if (has(meaning)) return meaning;
  return f.tag === 'textarea' ? 'message' : null;
}

/** Maps a described form to fields with the values TabReach would write. */
export function mapForm(form: RawForm, values: FormValues, knowledge: FormKnowledge): FormField[] {
  const shown = form.fields.filter((f) => f.visible);
  const meanings = shown.map((f) => meaningOf(f, knowledge));
  // "Имя" is a first name next to a last name field, and the whole name otherwise.
  const hasLast = meanings.includes('lastName');
  return shown.map((f, i) => {
    let meaning = meanings[i] ?? null;
    if (meaning === 'firstName' && !hasLast) meaning = 'name';
    if (meaning === 'name' && hasLast) meaning = 'firstName';
    const value = meaning && meaning !== 'consent' ? (valueFor(meaning, values) ?? null) : null;
    return {
      ref: f.ref,
      kind: kindOf(f),
      label: (f.label || f.placeholder || f.name).slice(0, 300),
      required: f.required,
      meaning,
      source: meaning ? ('pack' as const) : null,
      value: value === '' ? null : value,
    };
  });
}

const WRITABLE: ReadonlySet<FormField['kind']> = new Set(['text', 'email', 'tel', 'url', 'textarea']);

/** Fields the phrases did not recognize, as candidates for the resolver (never check boxes). */
export function unknownFields(form: RawForm, fields: FormField[]) {
  const raw = new Map(form.fields.map((f) => [f.ref, f]));
  return fields
    .filter((f) => f.meaning === null && WRITABLE.has(f.kind))
    .slice(0, 30)
    .map((f) => {
      const r = raw.get(f.ref);
      return {
        ref: f.ref,
        label: (r?.label ?? f.label).slice(0, 300),
        placeholder: (r?.placeholder ?? '').slice(0, 300),
        name: (r?.name ?? '').slice(0, 300),
        type: (r?.type ?? f.kind).slice(0, 30),
      };
    });
}

/** Applies the resolver's choices: only to fields still unknown, only meanings with a value. */
export function applyResolved(
  fields: FormField[],
  answer: ResolveTargetResult,
  values: FormValues,
): FormField[] {
  const chosen = new Map(answer.meanings.filter((m) => m.meaning !== null).map((m) => [m.ref, m.meaning]));
  return fields.map((f) => {
    const meaning = chosen.get(f.ref);
    if (!meaning || f.meaning !== null || !WRITABLE.has(f.kind)) return f;
    const value = valueFor(meaning, values) ?? null;
    return { ...f, meaning, source: 'ai', value: value === '' ? null : value };
  });
}

function startsWord(text: string, phrase: string): boolean {
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1] ?? '')) return true;
  }
  return false;
}

function valueFor(meaning: Exclude<FormFieldMeaning, 'consent'>, v: FormValues): string | undefined {
  if (meaning === 'name') return v.name ?? ([v.firstName, v.lastName].filter(Boolean).join(' ') || undefined);
  if (meaning === 'firstName') return v.firstName ?? v.name?.split(/\s+/)[0];
  if (meaning === 'lastName') return v.lastName ?? v.name?.split(/\s+/).slice(1).join(' ');
  return v[meaning];
}

/** The form as identified for approval: its fields, not their values. */
export function signatureOf(form: RawForm): string {
  const shape = form.fields.map((f) => [f.ref, f.tag, f.type, f.name, f.label, f.visible]);
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

interface FoundForm {
  handle: ElementHandle;
  raw: RawForm;
}

/** The best contact form on the page, waiting a moment for forms drawn by scripts. */
async function findContactForm(
  page: Page,
  signal: AbortSignal,
  waitMs = FORM_WAIT_MS,
): Promise<FoundForm | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal.throwIfAborted();
    let best: FoundForm | null = null;
    let bestScore = 0;
    for (const handle of (await page.$$('form')) as ElementHandle[]) {
      const raw = await handle.evaluate(DESCRIBE_FORM).catch(() => null); // detached meanwhile: skip
      const score = raw ? contactScore(raw) : 0;
      if (raw && score >= 3 && score > bestScore) {
        best = { handle, raw };
        bestScore = score;
      }
    }
    if (best || Date.now() > deadline) return best;
    await page.waitForTimeout(POLL_MS);
  }
}

async function challengeOn(page: Page, generic: AdapterPack | undefined): Promise<string | null> {
  const states = (generic?.states ?? []).filter((s) => s.kind === 'challenge');
  // A page changing under the probe is probed again by the caller's next look.
  const state = await matchState(states, probeOf(page)).catch(() => null);
  return state?.id ?? null;
}

/** Visible links and buttons whose text says "contact", on the same site. */
async function contactLeads(page: Page, knowledge: FormKnowledge, site: string) {
  const leads = await page.$$eval('a[href], button, [role=button]', (els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => ({
        link: el.tagName === 'A' ? ((el as unknown as { href: string }).href ?? null) : null,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
      })),
  );
  const says = (text: string) => knowledge.contactLinks.some((p) => text.toLowerCase().includes(p));
  const links = [
    ...new Set(
      leads
        .filter((l) => l.link && (says(l.text) || says(new URL(l.link).pathname)))
        .map((l) => l.link as string)
        .filter((href) => /^https?:/.test(href) && sameSite(new URL(href).hostname, site)),
    ),
  ];
  const buttons = leads.filter((l) => !l.link && l.text && says(l.text)).map((l) => l.text);
  return { links, buttons };
}

/** Opens a page; a missing page (4xx, 5xx) counts as not opened. */
async function goto(page: Page, url: string): Promise<boolean> {
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    return !response || response.status() < 400;
  } catch {
    return false;
  }
}

/** The site's own visible links (for the resolver): text, path and address, at most 40. */
async function siteLinks(page: Page, site: string): Promise<{ text: string; path: string; href: string }[]> {
  const all = await page.$$eval('a[href]', (els) =>
    els
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map((el) => ({
        href: (el as unknown as { href: string }).href,
        text: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 100),
      })),
  );
  const seen = new Set<string>();
  const out: { text: string; path: string; href: string }[] = [];
  for (const l of all) {
    if (!/^https?:/.test(l.href)) continue;
    const u = new URL(l.href);
    if (!sameSite(u.hostname, site) || seen.has(u.pathname)) continue;
    seen.add(u.pathname);
    out.push({ text: l.text, path: u.pathname.slice(0, 300), href: `${u.origin}${u.pathname}` });
    if (out.length >= 40) break;
  }
  return out;
}

/** Opens a dialog form: the button with exactly this text. */
async function open(page: Page, opener: string): Promise<boolean> {
  const button = page.getByRole('button', { name: opener, exact: true }).filter({ visible: true });
  if ((await button.count()) !== 1) return false;
  await button.click({ timeout: 10_000 });
  return true;
}

/**
 * PrepareFormSubmission (docs/14, Phase 6): from a website, find the contact form — on the page,
 * behind a "contact" link on the same site, or in a dialog a "contact" button opens — map its
 * fields, fill what TabReach may fill, and photograph it for approval. Nothing is sent. A consent
 * box is never ticked; a required field TabReach cannot fill, a required consent or a challenge
 * make it `needs_human`.
 */
export async function prepareForm(
  page: Page,
  req: { taskId: string; packId: string; url: string; values: FormValues },
  env: TaskEnvironment,
  signal: AbortSignal,
  /** Bounded semantic resolution through core (ADR 013); absent in tests of the phrases alone. */
  resolve?: (request: ResolveTargetRequest) => Promise<ResolveTargetResult>,
): Promise<FormPrepareResult> {
  const pack = env.pack(req.packId);
  const knowledge = pack?.forms;
  const base = {
    formUrl: null,
    opener: null,
    signature: null,
    fields: [],
    challenge: null,
    screenshot: null,
    packVersion: pack?.version ?? 'none',
  };
  if (!knowledge) return { ...base, status: 'failed', reason: 'task.unknownPack' };
  const site = new URL(req.url).hostname;
  if (!(await goto(page, req.url))) return { ...base, status: 'failed', reason: 'task.navigationFailed' };

  let found = await findContactForm(page, signal);
  let opener: string | null = null;
  if (!found) {
    const { links, buttons } = await contactLeads(page, knowledge, site);
    const origin = new URL(page.url()).origin;
    const candidates = links.length > 0 ? links : knowledge.contactPaths.map((p) => new URL(p, origin).href);
    for (const link of candidates.slice(0, MAX_CANDIDATE_PAGES)) {
      if (!(await goto(page, link)) || !sameSite(new URL(page.url()).hostname, site)) continue;
      found = await findContactForm(page, signal);
      if (found) break;
    }
    if (!found && resolve) {
      // No link said "contact": AI may pick one of the site's own links (closed list, one call).
      if (!(await goto(page, req.url))) return { ...base, status: 'failed', reason: 'task.navigationFailed' };
      const links = await siteLinks(page, site);
      if (links.length > 0) {
        const answer = await resolve({
          kind: 'contact_link',
          taskId: req.taskId,
          links: links.map((l, ref) => ({ ref, text: l.text, path: l.path })),
        }).catch(() => null); // the gateway failing is the same as no answer
        const chosen = answer?.available && answer.link !== null ? links[answer.link] : undefined;
        if (chosen && (await goto(page, chosen.href)) && sameSite(new URL(page.url()).hostname, site)) {
          found = await findContactForm(page, signal);
        }
      }
    }
    if (!found && buttons.length > 0) {
      if (!(await goto(page, req.url))) return { ...base, status: 'failed', reason: 'task.navigationFailed' };
      for (const text of buttons) {
        if (await open(page, text)) {
          found = await findContactForm(page, signal, 2_000);
          if (found) {
            opener = text;
            break;
          }
        }
      }
    }
  }
  if (!found) return { ...base, status: 'no_form', reason: 'form.notFound' };

  let fields = mapForm(found.raw, req.values, knowledge);
  const unknown = unknownFields(found.raw, fields);
  if (unknown.length > 0 && resolve) {
    // One call for all fields the phrases did not recognize; the answer only picks from the list.
    const answer = await resolve({ kind: 'form_fields', taskId: req.taskId, fields: unknown }).catch(
      () => null,
    );
    if (answer?.available) fields = applyResolved(fields, answer, req.values);
  }
  const formUrl = page.url().replace(/#.*$/, '');
  for (const field of fields) {
    if (field.value === null) continue;
    signal.throwIfAborted();
    await fill(found.handle, field.ref, field.value);
  }
  const challenge = await challengeOn(page, env.pack('generic'));
  const screenshot = await found.handle
    .screenshot({ timeout: 10_000 })
    .then((png) => png.toString('base64'))
    .catch(() => null); // the approval then shows the fields only
  const missing = fields.some((f) => f.required && f.meaning !== 'consent' && f.value === null);
  const consent = fields.some((f) => f.required && f.kind === 'checkbox');
  const result = {
    ...base,
    formUrl,
    opener,
    signature: signatureOf(found.raw),
    fields,
    challenge,
    screenshot,
  };
  if (missing) return { ...result, status: 'needs_human', reason: 'form.unmappedRequired' };
  if (consent) return { ...result, status: 'needs_human', reason: 'form.consentRequired' };
  if (challenge) return { ...result, status: 'needs_human', reason: 'form.challenge' };
  return { ...result, status: 'ready', reason: null };
}

async function fill(form: ElementHandle, ref: number, value: string): Promise<boolean> {
  const el = await form.evaluateHandle((f, i) => (f as unknown as DomForm).elements[i] ?? null, ref);
  // The handle is a DOM element in the page; DomField only describes it (see above).
  const input = el.asElement() as unknown as ElementHandle | null;
  if (!input) return false;
  await input.fill(value, { timeout: 10_000 });
  return (await input.inputValue()) === value;
}

/**
 * ExecuteFormSubmission (docs/14, Phase 6): open the same form, refuse it if its fields changed
 * since approval, write exactly the approved values, then the `about_to_commit` checkpoint and one
 * press of its one submit button (auto) — or the person presses it (assisted; always with a
 * challenge on the page). The result is `succeeded` only when the site says it received the
 * message; a refusal shown on the form is a verified "not sent"; anything else is `unknown`.
 */
export async function submitForm(
  page: Page,
  req: {
    taskId: string;
    packId: string;
    formUrl: string;
    opener: string | null;
    signature: string;
    fields: { ref: number; value: string }[];
    mode: BrowserExecutionMode;
  },
  env: TaskEnvironment,
  signal: AbortSignal,
  checkpoint: () => Promise<boolean>,
): Promise<TaskResult> {
  const pack = env.pack(req.packId);
  const knowledge = pack?.forms;
  const base = {
    packVersion: pack?.version ?? 'none',
    stateId: null,
    stateKind: null,
    diagnostics: null,
  } as const;
  const notSent = (over: Partial<TaskResult>): TaskResult => ({
    ...base,
    status: 'failed',
    url: safeUrl(page.url()),
    errorKey: null,
    committed: false,
    ...over,
  });
  if (!knowledge) return notSent({ errorKey: 'task.unknownPack' });
  if (!(await goto(page, req.formUrl))) return notSent({ errorKey: 'task.navigationFailed' });
  if (req.opener && !(await open(page, req.opener))) {
    return notSent({ status: 'unsupported_state', errorKey: 'form.changed' });
  }
  const found = await findContactForm(page, signal);
  if (!found || signatureOf(found.raw) !== req.signature) {
    return notSent({
      status: 'unsupported_state',
      errorKey: 'form.changed',
      diagnostics: await diagnose(page, req.taskId, ['form'], env),
    });
  }
  for (const field of req.fields) {
    signal.throwIfAborted();
    if (!(await fill(found.handle, field.ref, field.value))) return notSent({ errorKey: 'task.fillFailed' });
  }
  // A challenge is never solved: in auto mode nothing is pressed and the person is asked; in
  // assisted mode the person solves it and presses (FR-FRM-004).
  const challenge = await challengeOn(page, env.pack('generic'));
  if (challenge && req.mode === 'auto') {
    return notSent({
      status: 'needs_human',
      stateId: challenge,
      stateKind: 'challenge',
      errorKey: 'form.challenge',
    });
  }
  const mode = req.mode;
  // The page's own checks first: a form it would refuse is not pressed at all.
  if (!(await found.handle.evaluate((f) => (f as unknown as DomForm).checkValidity()).catch(() => false))) {
    return notSent({ errorKey: 'form.invalid' });
  }
  const buttons = await found.handle.$$(
    'button:not([type]), button[type=submit], input[type=submit], input[type=image]',
  );
  const visibleButtons: ElementHandle[] = [];
  for (const b of buttons) if (await b.isVisible()) visibleButtons.push(b);
  if (mode === 'auto' && visibleButtons.length !== 1) {
    return notSent({ status: 'needs_human', errorKey: 'form.submitAmbiguous' });
  }
  const button = visibleButtons[0] ?? null;
  const successBefore = await pageSays(page, knowledge.success);
  const urlBefore = page.url();
  const values = () =>
    found.handle.evaluate(
      (f, refs) => refs.map((r) => (f as unknown as DomForm).elements[r]?.value ?? null),
      req.fields.map((x) => x.ref),
    );
  const intact = async () =>
    JSON.stringify(await values().catch(() => null)) === JSON.stringify(req.fields.map((x) => x.value));
  if (!(await intact())) return notSent({ errorKey: 'task.stateChanged' });

  signal.throwIfAborted();
  if (!(await checkpoint())) return notSent({ errorKey: 'task.checkpointRefused' });
  if (mode === 'auto' && !(await intact())) return notSent({ errorKey: 'task.stateChanged' });
  // From here on the message may have been sent: every way out says so.
  const committed = { ...base, errorKey: null, committed: true } as const;
  try {
    let waitMs = VERIFY_TIMEOUT_MS;
    if (mode === 'auto' && button) {
      await button.click({ timeout: 10_000 });
    } else {
      await page.bringToFront();
      await button?.focus().catch(() => {}); // only a pointer for the person
      waitMs = ASSISTED_WAIT_MS;
    }
    const deadline = Date.now() + waitMs;
    for (;;) {
      signal.throwIfAborted();
      const formGone = !(await found.handle
        .evaluate((f) => (f as unknown as DomEl).isConnected)
        .catch(() => false));
      const moved = page.url() !== urlBefore;
      if ((moved || formGone || !successBefore) && (await pageSays(page, knowledge.success))) {
        return { ...committed, status: 'succeeded', url: safeUrl(page.url()) };
      }
      if (!formGone && !moved && (await refused(found.handle, knowledge))) {
        return { ...committed, status: 'failed', url: safeUrl(page.url()), errorKey: 'task.rejected' };
      }
      if (Date.now() > deadline) break;
      await page.waitForTimeout(POLL_MS);
    }
  } catch {
    return {
      ...committed,
      status: 'unknown',
      url: safeUrl(page.url()),
      errorKey: signal.aborted ? 'task.controlTaken' : 'task.verifyFailed',
    };
  }
  return {
    ...committed,
    status: 'unknown',
    url: safeUrl(page.url()),
    diagnostics: await diagnose(page, req.taskId, ['form.success'], env).catch(() => null),
  };
}

/** Visible text on the page containing one of the phrases. */
async function pageSays(page: Page, phrases: string[]): Promise<boolean> {
  const text = (
    await page
      .locator('body')
      .innerText({ timeout: 5_000 })
      .catch(() => '')
  ).toLowerCase();
  return phrases.some((p) => text.includes(p));
}

/** The form is still there and marks a field invalid, or an alert on it says it was refused. */
async function refused(form: ElementHandle, knowledge: FormKnowledge): Promise<boolean> {
  const marked = await form
    .evaluate((f) => (f as unknown as DomEl).querySelector('[aria-invalid="true"]') !== null)
    .catch(() => false);
  if (marked) return true;
  const alerts = await form
    .$$eval('[role=alert]', (els) => els.map((e) => (e.textContent ?? '').toLowerCase()))
    .catch(() => [] as string[]);
  return alerts.some((a) => knowledge.rejected.some((p) => a.includes(p)));
}
