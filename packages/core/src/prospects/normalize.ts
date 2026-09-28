import { domainToASCII } from 'node:url';
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
  return { channel: 'other', normalized: `${host}${path}`, original };
}

/** Case- and whitespace-insensitive key for comparing names. */
export function nameKey(input: string | null | undefined): string | null {
  const value = input?.trim().replace(/\s+/g, ' ').toLowerCase();
  return value ? value : null;
}

/** Lowercased, whitespace-collapsed text for LIKE search (Unicode-aware, unlike SQLite lower()). */
export function searchKey(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Splits a tag cell: `a; b, c` -> ['a', 'b', 'c'], trimmed, de-duplicated case-insensitively. */
export function splitTags(input: string | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[;,|]/)) {
    const tag = raw.trim().replace(/\s+/g, ' ');
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag.slice(0, 60));
  }
  return out;
}
