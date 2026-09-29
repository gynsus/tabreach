import type { DraftCheck, DraftOrigin } from '@tabreach/protocol';

/** What the draft checks look at (docs/17 "approve_campaign", ADR 025). */
export interface DraftCheckInput {
  origin: DraftOrigin;
  subject: string | null;
  /** The whole body, signature included. */
  body: string;
  /** The rendered signature the body must end with; empty when the step has none. */
  signature: string;
  /** The address the draft was written for, and the contact's address now. */
  target: string;
  currentTarget: string | null;
  maxLength: number;
  forbiddenPhrases: readonly string[];
  allowedLinkDomains: readonly string[];
  /**
   * Text a specific may come from: the facts the draft used (claims and quotes), the contact's
   * and company's fields, the step's instructions or template, earlier messages to this contact.
   */
  sources: readonly string[];
}

const MIN_LENGTH = 20;
const MAX_LISTED = 8;

/** Runs every check. Each result says what failed in words the user can act on. */
export function runDraftChecks(input: DraftCheckInput): DraftCheck[] {
  const own = withoutSignature(input.body, input.signature);
  const text = [input.subject ?? '', own].join('\n');
  return [
    grounding(text, input.sources),
    length(input.body, input.maxLength),
    forbiddenPhrases(text, input.forbiddenPhrases),
    links(text, input.allowedLinkDomains),
    signature(input.body, input.signature),
    {
      key: 'target',
      passed: input.currentTarget !== null && input.currentTarget === input.target,
      detail: input.currentTarget === input.target ? null : (input.currentTarget ?? '—'),
    },
  ];
}

export function allPassed(checks: readonly DraftCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.passed);
}

function withoutSignature(body: string, sig: string): string {
  const s = sig.trim();
  const b = body.trimEnd();
  return s && b.endsWith(s) ? b.slice(0, b.length - s.length) : b;
}

// Grounding ---------------------------------------------------------------------------------

/** Pronouns and the like that are capitalised in the middle of a sentence without being names. */
const NOT_NAMES = new Set([
  'i',
  "i'm",
  'i’m',
  "i've",
  'i’ve',
  "i'd",
  'i’d',
  "i'll",
  'i’ll',
  'вы',
  'вас',
  'вам',
  'ваш',
  'ваша',
  'ваше',
  'ваши',
  'вами',
]);

/**
 * Specifics a reader takes as facts about them — numbers and names — must come from a source
 * (docs/15 "Grounding verification"). Deterministic on purpose: it cannot be talked out of a
 * verdict, costs nothing, and when in doubt it fails, which only means a person reviews the draft.
 * Words that start a sentence are not taken for names (they are capitalised anyway).
 */
function grounding(text: string, sources: readonly string[]): DraftCheck {
  const sourceText = sources.join('\n');
  const sourceNumbers = new Set(numbers(sourceText));
  const sourceWords = new Set(words(sourceText).map((w) => w.toLowerCase()));
  const unsupported = new Set<string>();
  for (const n of numbersWithText(text)) {
    if (!sourceNumbers.has(n.digits)) unsupported.add(n.text);
  }
  for (const name of names(text)) {
    // A compound ("ИИ-направление") is checked by its capitalised parts.
    const parts = name.split(/[-\u2010\u2013]/).filter((p) => /^\p{Lu}/u.test(p) && p.length > 1);
    if (!parts.every((p) => knownWord(p.toLowerCase(), sourceWords))) unsupported.add(name);
  }
  const list = [...unsupported];
  return {
    key: 'grounding',
    passed: list.length === 0,
    detail: list.length ? list.slice(0, MAX_LISTED).join(', ') : null,
  };
}

const NUMBER = /\d(?:[\d\u00a0\u202f .,]*\d)?/g;

function numbersWithText(text: string): { text: string; digits: string }[] {
  // Links are judged by the links check; their digits are not claims.
  const plain = text.replace(URL_OR_EMAIL, ' ');
  return [...plain.matchAll(NUMBER)].map((m) => ({ text: m[0].trim(), digits: m[0].replace(/\D/g, '') }));
}

function numbers(text: string): string[] {
  return numbersWithText(text).map((n) => n.digits);
}

function words(text: string): string[] {
  return text.match(/[\p{L}\p{M}][\p{L}\p{M}\d'’-]*/gu) ?? [];
}

/** Capitalised words (and acronyms) that do not start a sentence. */
function names(text: string): string[] {
  const plain = text.replace(URL_OR_EMAIL, ' ');
  const found: string[] = [];
  for (const m of plain.matchAll(/[\p{L}\p{M}][\p{L}\p{M}\d'’-]*/gu)) {
    const word = m[0];
    if (!/^\p{Lu}/u.test(word) || word.length < 2) continue;
    if (NOT_NAMES.has(word.toLowerCase())) continue;
    const before = plain.slice(0, m.index).trimEnd();
    const startsSentence =
      before === '' || /[.!?…:;\n«"“(—-]$/.test(before) || /\n\s*$/.test(plain.slice(0, m.index));
    if (startsSentence && !/^\p{Lu}[\p{Lu}\d]+$/u.test(word)) continue;
    found.push(word);
  }
  return found;
}

/** The word, or a form of it (Russian endings: "Москве" for "Москва"), appears in the sources. */
function knownWord(word: string, sourceWords: ReadonlySet<string>): boolean {
  if (sourceWords.has(word)) return true;
  if (word.length < 5) return false;
  const stem = word.slice(0, Math.max(4, word.length - 2));
  for (const w of sourceWords) if (w.startsWith(stem)) return true;
  return false;
}

// Other checks ------------------------------------------------------------------------------

function length(body: string, max: number): DraftCheck {
  const n = body.trim().length;
  const passed = n >= MIN_LENGTH && n <= max;
  return { key: 'length', passed, detail: passed ? null : `${n}/${max}` };
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .replace(/ё/g, 'е');

function forbiddenPhrases(text: string, phrases: readonly string[]): DraftCheck {
  const t = normalize(text);
  const found = phrases.filter((p) => p.trim() && t.includes(normalize(p.trim())));
  return {
    key: 'forbidden_phrases',
    passed: found.length === 0,
    detail: found.length ? found.slice(0, MAX_LISTED).join(', ') : null,
  };
}

const URL_OR_EMAIL =
  /\b(?:https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}|(?:[\p{L}\d-]+\.)+(?:com|net|org|io|dev|ru|рф|de|uk|eu|co|ai|app|info|biz|me)(?:\/[^\s<>"')\]]*)?)/giu;

/** Links and email addresses only to allowed domains (the signature is exempt: the user wrote it). */
function links(text: string, allowed: readonly string[]): DraftCheck {
  const domains = allowed.map((d) =>
    d
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, ''),
  );
  const bad: string[] = [];
  for (const m of text.matchAll(URL_OR_EMAIL)) {
    const host = hostOf(m[0]);
    if (!host || !domains.some((d) => host === d || host.endsWith(`.${d}`))) bad.push(m[0]);
  }
  return {
    key: 'links',
    passed: bad.length === 0,
    detail: bad.length ? bad.slice(0, MAX_LISTED).join(', ') : null,
  };
}

function hostOf(link: string): string | null {
  const at = link.lastIndexOf('@');
  if (at >= 0 && !/^https?:/i.test(link)) return link.slice(at + 1).toLowerCase();
  try {
    return new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return null;
  }
}

function signature(body: string, sig: string): DraftCheck {
  const s = sig.trim();
  const passed = !s || body.trimEnd().endsWith(s);
  return { key: 'signature', passed, detail: null };
}
