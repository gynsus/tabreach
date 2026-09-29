import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

export interface ExtractedPage {
  title: string | null;
  /** Main content as plain text; hidden elements and navigation are left out. */
  text: string;
  links: { url: string; text: string }[];
}

const MAX_TEXT = 60_000;

/** The part of a DOM element this module uses (core has no DOM types; linkedom provides the DOM). */
interface El {
  getAttribute(name: string): string | null;
  textContent: string | null;
  remove(): void;
}
const all = (root: { querySelectorAll(selector: string): unknown }, selector: string) =>
  Array.from(root.querySelectorAll(selector) as ArrayLike<El>);

/** HTML → main text and links (docs/16 "Collection strategy": Readability-style extraction). */
export function extractPage(html: string, url: string): ExtractedPage {
  const { document } = parseHTML(html);
  const links: { url: string; text: string }[] = [];
  for (const a of all(document, 'a[href]')) {
    const href = a.getAttribute('href') ?? '';
    try {
      links.push({ url: new URL(href, url).toString(), text: (a.textContent ?? '').trim().slice(0, 100) });
    } catch {
      // not a URL: ignore the link
    }
  }
  // Text a reader cannot see is not evidence (and a favourite hiding place for injected prompts).
  for (const el of all(document, 'script, style, noscript, template, [hidden], [aria-hidden="true"]'))
    el.remove();
  for (const el of all(document, '[style]')) {
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute('style') ?? '')) el.remove();
  }
  const title = (document.querySelector('title')?.textContent ?? '').trim() || null;
  let text: string;
  try {
    const article = new Readability(
      document as unknown as ConstructorParameters<typeof Readability>[0],
    ).parse();
    text = article?.textContent ?? '';
  } catch {
    text = '';
  }
  if (text.trim().length < 50) text = document.body?.textContent ?? '';
  return { title, text: normalizeText(text).slice(0, MAX_TEXT), links };
}

export function normalizeText(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim();
}
