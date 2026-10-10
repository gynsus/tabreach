/**
 * Secret redaction shared by the audit trail and the logs (docs/20-OBSERVABILITY.md, FR-AUD-004).
 * Keys are normalized (case, `_`, `-` removed) so `access_token`, `X-Api-Key` and `refreshToken`
 * are treated alike. Values that look like bearer tokens or API keys are scrubbed inside strings.
 */

const EXACT = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'setcookie',
  'plaintext',
  'ciphertext',
  'privatekey',
  'credentials',
]);
// `...Tokens` (token counts) stays visible; `...Token` (a credential) does not.
const SUFFIXES = ['secret', 'password', 'apikey', 'token', 'cookie', 'privatekey', 'credentials'];

export const REDACTED = '[REDACTED]';
const TRUNCATED = '[TRUNCATED]';

export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  return EXACT.has(k) || SUFFIXES.some((s) => k.endsWith(s));
}

const TOKEN_PATTERNS = [
  /\bbearer\s+[\w.~+/=-]{8,}/gi,
  /\bsk-[\w-]{16,}/g, // Anthropic / OpenAI style keys
  /\bya29\.[\w.-]{10,}/g, // Google OAuth access tokens
  /\b1\/\/[\w.-]{20,}/g, // Google OAuth refresh tokens
];

export function scrubString(value: string): string {
  return TOKEN_PATTERNS.reduce((s, re) => s.replace(re, REDACTED), value);
}

/** Deep copy with secrets removed. Fails closed: anything past `maxDepth` is dropped, not kept. */
export function redactDeep(value: unknown, maxDepth = 8, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= maxDepth) return TRUNCATED;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, maxDepth, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redactDeep(v, maxDepth, depth + 1);
  }
  return out;
}

/**
 * An error for a log line about a browser or a fetch: its name and the first line of its message,
 * with URLs cut to their origin and file paths removed. Playwright errors carry the Chrome command
 * line (`--user-data-dir=<profile>`) and the page URL; neither belongs in logs (CLAUDE.md §3.10).
 */
export function errorSummary(error: unknown): { name: string; message: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const message = scrubString((raw.split('\n')[0] ?? '').slice(0, 500))
    // A profile path may contain spaces ("Application Support"): everything up to the next flag.
    .replace(/--user-data-dir=.*?(?=\s--|$)/g, '--user-data-dir=<profile>')
    .replace(/\bhttps?:\/\/[^\s"'<>)]+/gi, (url) => {
      try {
        return new URL(url).origin;
      } catch {
        return '<url>';
      }
    })
    .replace(/(?:~|\.{0,2})?\/(?:[^\s"'<>/:]+\/)+[^\s"'<>:,)]*/g, '<path>');
  return { name, message };
}
