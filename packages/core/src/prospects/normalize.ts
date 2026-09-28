import { domainToASCII } from 'node:url';
import { customFieldValueSchema, type CustomFields } from '@tabreach/protocol';
import { z } from 'zod';

/**
 * Normalization used for matching: dedupe (FR-PROS-005), suppressions and, later, frequency caps.
 * Originals are always stored alongside (docs/25-DEVELOPMENT-CONVENTIONS.md, "URLs").
 * Keep this the single place that decides whether two identities are the same.
 */

// WHATWG (HTML5) email syntax: unlike Zod's default it accepts punycode TLDs such as `xn--p1ai` (.рф).
const emailSchema = z.email({ pattern: z.regexes.html5Email });

/**
 * Lowercased, trimmed email with an internationalized domain in punycode (`p@ромашка.рф` ->
 * `p@xn--80aa...`), or null when invalid. The local part must be ASCII: non-ASCII mailboxes need
 * SMTPUTF8, which many servers still reject.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  const value = input?.trim().toLowerCase();
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const domain = domainToASCII(value.slice(at + 1));
  if (!domain) return null;
  const ascii = `${value.slice(0, at)}@${domain}`;
  return domain.includes('.') && emailSchema.safeParse(ascii).success ? ascii : null;
}

/**
 * Registrable-looking host for matching: lowercase ASCII (punycode), without scheme, port, path,
 * trailing dot or a leading `www.`. Accepts a bare domain, a URL or an email address.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  let value = input?.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('@') && !value.includes('/')) value = value.slice(value.lastIndexOf('@') + 1);
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
  let host: string;
  try {
    host = new URL(value).hostname;
  } catch {
    return null;
  }
  host = domainToASCII(host.replace(/\.$/, '')).replace(/^www\./, '');
  if (!host || !host.includes('.') || /^[\d.]+$/.test(host)) return null;
  return host;
}

export type ProfileChannel = 'linkedin' | 'other';

export interface NormalizedProfileUrl {
  channel: ProfileChannel;
  normalized: string;
  original: string;
}

/**
 * Canonical profile URL: LinkedIn person profiles become `linkedin.com/in/<slug>` regardless of
 * country subdomain, query string, trailing slash or percent-encoding; other URLs keep host and
 * path without scheme, `www.`, query, fragment or trailing slash.
 */
export function normalizeProfileUrl(input: string | null | undefined): NormalizedProfileUrl | null {
  const original = input?.trim();
  if (!original) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(original) ? original : `https://${original}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');

  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
    const match = /^\/in\/([^/]+)/.exec(path);
    if (!match?.[1]) return null;
    let slug: string;
    try {
      slug = decodeURIComponent(match[1]);
    } catch {
      return null;
    }
    return { channel: 'linkedin', normalized: `linkedin.com/in/${slug.toLowerCase()}`, original };
  }
  // Other sites often identify a profile by query (`profile.php?id=1`), so the query stays.
  return { channel: 'other', normalized: `${host}${path}${url.search}`, original };
}

/**
 * Case-, whitespace- and Unicode-form-insensitive key for comparing names. NFC makes "Café" typed
 * on a keyboard equal the decomposed "Cafe\u0301" that macOS and Excel exports often contain.
 */
export function nameKey(input: string | null | undefined): string | null {
  const value = input?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return value ? value : null;
}

/** Lowercased, whitespace-collapsed text for LIKE search (Unicode-aware, unlike SQLite lower()). */
export function searchKey(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .join(' ')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Splits a CSV tag cell: `a; b, c` -> ['a', 'b', 'c'] (see cleanTags). */
export function splitTags(input: string | null | undefined): string[] {
  return input ? cleanTags(input.split(/[;,|]/)) : [];
}

/**
 * Trims, NFC-normalizes, caps length and de-duplicates a tag list case-insensitively. Tags that
 * arrive as a list (API, forms) are not split further: "R&D, EU" can be one tag.
 */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, 60);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export const CUSTOM_FIELD_KEY_MAX = 100;

/**
 * Reads stored custom fields tolerantly: entries that no longer pass validation are dropped
 * instead of failing the whole list (one bad value must not break every page that shows it).
 */
export function readCustomFields(json: string): CustomFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: CustomFields = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.length === 0 || k.length > CUSTOM_FIELD_KEY_MAX) continue;
    const value = customFieldValueSchema.safeParse(v);
    if (value.success) out[k] = value.data;
  }
  return out;
}
