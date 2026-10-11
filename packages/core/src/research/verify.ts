/**
 * Quote verification (docs/15 "Grounding verification"): a fact counts only if its quote is a
 * substring of the evidence text after normalization — Unicode form, case, whitespace, and the
 * usual typographic variants of quotes, apostrophes and dashes.
 */
export function normalizeForQuote(text: string): string {
  return foldTypography(text.normalize('NFKC').toLocaleLowerCase()).replace(/\s+/g, ' ').trim();
}

function foldTypography(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u201B\u2032`\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...');
}

/** Too short a quote proves nothing ("the", "in 2026"). */
export const MIN_QUOTE_CHARS = 12;

export function quoteFound(quote: string, evidenceText: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= MIN_QUOTE_CHARS && normalizeForQuote(evidenceText).includes(q);
}

/**
 * Where a verified quote is in the evidence text, as positions in the original text, for showing
 * it highlighted (FR-RES-005). The same normalization as `quoteFound`, applied character by
 * character so each normalized character remembers where it came from; null if not found.
 */
export function locateQuote(quote: string, evidenceText: string): { start: number; end: number } | null {
  const q = normalizeForQuote(quote);
  if (q.length < MIN_QUOTE_CHARS) return null;
  let normalized = '';
  const from: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < evidenceText.length;) {
    const codePoint = evidenceText.codePointAt(i) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    const piece = foldTypography(String.fromCodePoint(codePoint).normalize('NFKC').toLocaleLowerCase());
    for (const ch of piece) {
      const space = /\s/.test(ch);
      if (space && lastWasSpace) continue;
      normalized += space ? ' ' : ch;
      for (let k = 0; k < ch.length; k++) from.push(i);
      lastWasSpace = space;
    }
    i += width;
  }
  const at = normalized.indexOf(q);
  if (at < 0) return null;
  const last = from[at + q.length - 1] ?? 0;
  return { start: from[at] ?? 0, end: last + (evidenceText.codePointAt(last)! > 0xffff ? 2 : 1) };
}
