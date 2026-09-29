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
  // Compounds count whole and by their parts ("B2B-рассылок" also gives "b2b").
  const sourceWords = new Set(
    words(sourceText).flatMap((w) => [w, ...w.split(/[-\u2010\u2013]/)].map((p) => p.toLowerCase())),
  );
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

/**
 * Capitalised words and acronyms a reader could take for a name. A word that starts a sentence
 * (after . ! ? … or at the start of a line) is capitalised anyway, so it is let through only when
 * it is plainly an ordinary word (see `ordinaryWord`) or appears in lower case in the draft; any
 * other one is checked like a name. Brackets, quotes, colons and dashes do not start a sentence.
 */
function names(text: string): string[] {
  const plain = text.replace(URL_OR_EMAIL, ' ');
  const lowerWords = new Set(words(plain).filter((w) => !/^\p{Lu}/u.test(w)));
  const found: string[] = [];
  for (const m of plain.matchAll(/[\p{L}\p{M}][\p{L}\p{M}\d'’-]*/gu)) {
    const word = m[0];
    if (!/^\p{Lu}/u.test(word) || word.length < 2) continue;
    const lower = word.toLowerCase();
    if (NOT_NAMES.has(lower)) continue;
    const before = plain.slice(0, m.index);
    const startsSentence = /(^|[.!?…]\s+|\n[\t ]*(?:[-•*–]\s+)?)$/u.test(before);
    const acronym = /^\p{Lu}[\p{Lu}\d]+$/u.test(word);
    if (startsSentence && !acronym && (ordinaryWord(lower) || lowerWords.has(lower))) continue;
    found.push(word);
  }
  return found;
}

/** Words that commonly open a sentence in outreach mail; they are not names. */
const STARTERS = new Set(
  (
    'a an the i we you he she it they this that these those there here my our your his her its their ' +
    'hi hello hey dear good thanks thank congratulations congrats best kind warm regards cheers sincerely ' +
    'please would could can may might will shall should do does did is are was were be been have has had ' +
    'if when while since because as so but and or also then now yet still just only even perhaps maybe ' +
    'what why how where who which whether with without for from about after before during over under ' +
    'at by in on to of into onto upon through across between among per via let lets happy glad sorry ' +
    'quick short one two first next last another other some any each every all both many much more most ' +
    'no not nothing none yes sure great nice looking hope hoping wanted saw noticed read heard ' +
    'здравствуйте добрый доброе привет спасибо благодарю с уважением уважаемый уважаемая ' +
    'я мы вы он она оно они это этот эта эти тот та те там тут здесь мой наш ваш его её их ' +
    'если когда пока так как потому поэтому но и или а также тоже ещё уже только даже может возможно ' +
    'что чем почему зачем где кто какой какая какие который которая чтобы ли бы же ведь вот ' +
    'в во на с со к ко по о об от до из за для при про без над под через между после перед ' +
    'да нет конечно кстати например кроме однако впрочем итак сейчас сегодня завтра недавно давно ' +
    'один одна одно два две первый первая второй следующий последний другой каждый все всё весь ' +
    'хотел хотела хочу хотим хотим готов готовы рад рады предлагаю предлагаем подскажите напишите'
  ).split(/\s+/),
);

/**
 * An ordinary word by its form: a listed opener, a Russian verb, adverb, adjective or participle
 * ending, or an English adverb / -ing / -ed form. Names rarely take these endings.
 */
function ordinaryWord(lower: string): boolean {
  if (STARTERS.has(lower)) return true;
  if (/[а-яё]/.test(lower))
    return /(л|ли|ла|ло|ть|ти|те|йте|ьте|ем|им|ет|ит|ют|ят|ешь|ишь|ся|сь|но|ко|во|ее|ое|ая|яя|ые|ие|ий|ый|ой|ую|юю|их|ых|ему|ому|ого|его)$/.test(
      lower,
    );
  return /(ly|ing|ed)$/.test(lower);
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

/**
 * URLs, email addresses and anything shaped like a host name: labels joined by dots, ending in
 * a label of two or more letters (any TLD — `bit.ly`, `offer.xyz`, `пример.рф`). Filenames such as
 * `deck.pdf` match too; a false alarm only means a person reads the draft.
 */
const URL_OR_EMAIL =
  /(?:https?:\/\/[^\s<>"')\]]+|www\.[^\s<>"')\]]+|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.\p{L}{2,}|(?<![\p{L}\d@.-])(?:[\p{L}\d][\p{L}\d-]*\.)+\p{L}{2,}(?![\p{L}\d])(?:\/[^\s<>"')\]]*)?)/giu;

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
