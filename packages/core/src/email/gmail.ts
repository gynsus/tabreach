import { createHash, randomBytes } from 'node:crypto';
import type { SendResult } from '../channels/channel.js';

/** HTTP as core uses it for Google APIs; tests pass a fake. */
export type Http = (url: string, init: RequestInit) => Promise<Response>;

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_TIMEOUT_MS = 60_000;

/** gmail.send is a sensitive scope, gmail.readonly a restricted one (ADR 016); both are needed. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export class OAuthError extends Error {
  override name = 'OAuthError';
  constructor(
    /** invalid_grant: the refresh token was revoked or expired; the user must sign in again. */
    readonly kind: 'invalid_grant' | 'invalid_client' | 'network' | 'other',
    message: string,
  ) {
    super(message);
  }
}

export class GmailError extends Error {
  override name = 'GmailError';
  constructor(
    readonly status: number,
    message: string,
    /** Google's reason code (e.g. `rateLimitExceeded`), when the response has one. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }

  /** 403 is also how Gmail reports quotas and rate limits: those are not a credentials problem. */
  get isQuota(): boolean {
    return this.status === 429 || (this.reason !== null && QUOTA_REASONS.has(this.reason));
  }

  get isAuth(): boolean {
    return (this.status === 401 || this.status === 403) && !this.isQuota;
  }
}

const QUOTA_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'dailyLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
]);

/** Revokes a refresh token at Google (on disconnect). Best effort: false when it did not work. */
export async function revokeToken(http: Http, token: string): Promise<boolean> {
  try {
    const res = await http('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const base64url = (b: Buffer) =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkce(): { verifier: string; challenge: string; state: string } {
  const verifier = base64url(randomBytes(32));
  return {
    verifier,
    challenge: base64url(createHash('sha256').update(verifier).digest()),
    state: base64url(randomBytes(16)),
  };
}

/** The consent URL, without `redirect_uri`: main adds its loopback address. */
export function authorizeUrl(clientId: string, challenge: string, state: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  // A refresh token every time, even when the user connected this client before.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken: string | null;
  scope: string;
}

async function tokenRequest(http: Http, body: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await http(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new OAuthError('network', 'Token endpoint unreachable');
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = String(json.error ?? 'other');
    // Only the error code is kept: Google's description may echo request details.
    throw new OAuthError(
      error === 'invalid_grant' || error === 'invalid_client' ? error : 'other',
      `Token request failed: ${error}`,
    );
  }
  return {
    accessToken: String(json.access_token ?? ''),
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    scope: String(json.scope ?? ''),
  };
}

export function exchangeCode(
  http: Http,
  o: { clientId: string; clientSecret: string | null; code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(http, {
    grant_type: 'authorization_code',
    client_id: o.clientId,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
  });
}

export function refreshAccessToken(
  http: Http,
  o: { clientId: string; clientSecret: string | null; refreshToken: string },
): Promise<TokenSet> {
  return tokenRequest(http, {
    grant_type: 'refresh_token',
    client_id: o.clientId,
    ...(o.clientSecret ? { client_secret: o.clientSecret } : {}),
    refresh_token: o.refreshToken,
  });
}

/** Errors before any byte of the request left the machine: nothing can have been sent. */
const NOT_CONNECTED = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * Gmail API over HTTPS (users.messages.send / list / get, users.history.list). `token` returns a
 * valid access token; `refresh` forces a new one after a 401.
 */
export class GmailApi {
  constructor(
    private readonly http: Http,
    private readonly token: (forceRefresh?: boolean) => Promise<string>,
  ) {}

  profile(signal: AbortSignal): Promise<{ emailAddress: string; historyId: string }> {
    return this.json('GET', '/profile', undefined, signal);
  }

  /**
   * Sends a raw RFC 5322 message. Maps failures to ledger outcomes (ADR 023): a request that never
   * connected, or an explicit refusal (4xx), is not sent; a lost answer or a server error is unknown.
   */
  async send(raw: Buffer, signal: AbortSignal): Promise<SendResult> {
    let result: { id: string; threadId: string };
    try {
      result = await this.json('POST', '/messages/send', { raw: base64url(raw) }, signal);
    } catch (error) {
      if (error instanceof OAuthError) return { outcome: 'not_sent', errorClass: 'auth_failed' };
      if (error instanceof GmailError) {
        if (error.isQuota) return { outcome: 'not_sent', errorClass: 'rate_limited' };
        if (error.isAuth) return { outcome: 'not_sent', errorClass: 'auth_failed' };
        if (error.status >= 400 && error.status < 500)
          return { outcome: 'not_sent', errorClass: 'gmail_rejected', permanent: error.status === 400 };
        return { outcome: 'unknown', errorClass: 'gmail_server_error' };
      }
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code && NOT_CONNECTED.has(code)) return { outcome: 'not_sent', errorClass: 'gmail_unreachable' };
      return { outcome: 'unknown', errorClass: 'gmail_no_confirmation' };
    }
    return { outcome: 'completed', externalRefs: { gmailId: result.id, threadId: result.threadId } };
  }

  /** Whether a message with this Message-ID exists in the mailbox (Sent included). */
  async hasRfcMessage(messageId: string, signal: AbortSignal): Promise<boolean> {
    const q = encodeURIComponent(`rfc822msgid:${messageId.replace(/^<|>$/g, '')}`);
    const res = await this.json<{ messages?: unknown[] }>(
      'GET',
      `/messages?q=${q}&includeSpamTrash=true&maxResults=1`,
      undefined,
      signal,
    );
    return (res.messages?.length ?? 0) > 0;
  }

  /**
   * Inbox messages added after `startHistoryId`. `expired`: Google no longer has that history (it
   * keeps about a week); the caller restarts from the current position.
   */
  /**
   * Inbox messages added after `startHistoryId`, oldest first, each with the history id of its
   * record so the caller can advance message by message. `expired`: Google no longer has that
   * history (it keeps about a week); the caller restarts from the current position.
   */
  async inboxSince(
    startHistoryId: string,
    signal: AbortSignal,
  ): Promise<{ historyId: string; added: { historyId: string; messageId: string }[]; expired: boolean }> {
    const added: { historyId: string; messageId: string }[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let historyId = startHistoryId;
    try {
      do {
        const res = await this.json<{
          history?: { id: string; messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[];
          historyId?: string;
          nextPageToken?: string;
        }>(
          'GET',
          `/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX${pageToken ? `&pageToken=${pageToken}` : ''}`,
          undefined,
          signal,
        );
        for (const h of res.history ?? []) {
          for (const m of h.messagesAdded ?? []) {
            if (m.message.labelIds?.includes('INBOX') === false || seen.has(m.message.id)) continue;
            seen.add(m.message.id);
            added.push({ historyId: h.id, messageId: m.message.id });
          }
        }
        historyId = res.historyId ?? historyId;
        pageToken = res.nextPageToken;
      } while (pageToken && added.length < 500);
    } catch (error) {
      if (error instanceof GmailError && error.status === 404) {
        return { historyId: (await this.profile(signal)).historyId, added: [], expired: true };
      }
      throw error;
    }
    return { historyId, added, expired: false };
  }

  /**
   * A message for reply matching, within `maxBytes`: whole when it is small enough; otherwise its
   * headers and Gmail's text snippet, built from `format=metadata` (audit 3.5: bounded memory).
   */
  async load(id: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    const meta = await this.json<{
      sizeEstimate?: number;
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    }>('GET', `/messages/${id}?format=metadata`, undefined, signal);
    if ((meta.sizeEstimate ?? 0) <= maxBytes) return this.raw(id, signal);
    const headers = (meta.payload?.headers ?? []).map(
      (h) => `${h.name}: ${h.value.replace(/[\r\n]+/g, ' ')}`,
    );
    return Buffer.from(
      [...headers, 'Content-Type: text/plain; charset=utf-8', '', meta.snippet ?? '', ''].join('\r\n'),
    );
  }

  async raw(id: string, signal: AbortSignal): Promise<Buffer> {
    const res = await this.json<{ raw: string }>('GET', `/messages/${id}?format=raw`, undefined, signal);
    return Buffer.from(res.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }

  private async json<T>(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    retried = false,
  ): Promise<T> {
    const token = await this.token(retried);
    const res = await this.http(`${GMAIL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (res.status === 401 && !retried) return this.json(method, path, body, signal, true);
    if (!res.ok) {
      // Only Google's reason code is kept: messages may echo request details.
      const detail = (await res.json().catch(() => ({}))) as {
        error?: { errors?: { reason?: string }[]; status?: string };
      };
      const reason = detail.error?.errors?.[0]?.reason ?? detail.error?.status ?? null;
      throw new GmailError(
        res.status,
        `Gmail API ${method} ${path.split('?')[0]} failed with ${res.status}`,
        reason,
      );
    }
    return (await res.json()) as T;
  }
}
