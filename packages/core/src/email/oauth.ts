import { createHash, randomBytes } from 'node:crypto';
import type { Http } from './gmail.js';

/** OAuth 2.0 pieces shared by Google and Microsoft sign-in (ADR 016, ADR 032). */

const REQUEST_TIMEOUT_MS = 60_000;

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

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  /** Google returns one on the first exchange only; Microsoft a new one on every refresh. */
  refreshToken: string | null;
  scope: string;
}

/**
 * Errors that mean the grant itself is gone and only the user can bring it back. Microsoft says
 * `interaction_required` when, for example, a new MFA or Conditional Access prompt is needed.
 */
const GRANT_GONE = new Set(['invalid_grant', 'interaction_required', 'consent_required']);

export async function tokenRequest(http: Http, url: string, body: Record<string, string>): Promise<TokenSet> {
  let res: Response;
  try {
    res = await http(url, {
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
    // Only the error code is kept: descriptions may echo request details.
    const kind = GRANT_GONE.has(error) ? 'invalid_grant' : error === 'invalid_client' ? error : 'other';
    throw new OAuthError(kind, `Token request failed: ${error}`);
  }
  return {
    accessToken: String(json.access_token ?? ''),
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : null,
    scope: String(json.scope ?? ''),
  };
}
