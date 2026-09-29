/**
 * Quote verification (docs/15 "Grounding verification"): a fact counts only if its quote is a
 * substring of the evidence text after normalization — Unicode form, case, whitespace, and the
 * usual typographic variants of quotes, apostrophes and dashes.
 */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B\u2032`\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Too short a quote proves nothing ("the", "in 2026"). */
export const MIN_QUOTE_CHARS = 12;

export function quoteFound(quote: string, evidenceText: string): boolean {
  const q = normalizeForQuote(quote);
  return q.length >= MIN_QUOTE_CHARS && normalizeForQuote(evidenceText).includes(q);
}
