import { createHash } from 'node:crypto';
import type { OAuthDeps } from './accounts.js';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const MICROSOFT_REDIRECT = 'http://localhost:53682';

/**
 * Microsoft's sign-in and token endpoints, in memory (ADR 032). Checks PKCE, the client and the
 * redirect; rotates the refresh token on every renewal and accepts only the newest one, like a
 * strict Entra tenant. The mail servers ask `accepts` whether an access token is valid.
 */
export class FakeMicrosoft {
  clientId = '11111111-2222-3333-4444-555555555555';
  /** The account the person signs in with on the page. */
  signedInAs = 'me@outlook.test';
  /** What the person (or Entra) does on the sign-in page. */
  consent: 'allow' | 'deny' | 'wrong_state' | 'unauthorized_client' = 'allow';
  grantedScope = 'https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';
  giveRefreshToken = true;
  /** The grant was revoked or needs a new MFA prompt. */
  grantGone = false;
  /** Access tokens live this long. */
  expiresIn = 3599;
  readonly authorizeUrls: URL[] = [];
  refreshCalls = 0;
  private challenge = '';
  private counter = 0;
  private refreshToken = '';
  private readonly access = new Map<string, string>();

  /** Whether the mail server takes this token for this mailbox. */
  accepts(user: string, token: string): boolean {
    return this.access.get(token) === user;
  }

  /** Every access token handed out so far stops working (e.g. the password was changed). */
  revokeAccessTokens(): void {
    this.access.clear();
  }

  readonly deps: OAuthDeps = {
    loopback: async (authorizeUrl) => {
      const url = new URL(authorizeUrl);
      this.authorizeUrls.push(url);
      this.challenge = url.searchParams.get('code_challenge') ?? '';
      const state = url.searchParams.get('state') ?? '';
      if (this.consent === 'deny')
        return { redirectUri: MICROSOFT_REDIRECT, params: { error: 'access_denied', state } };
      if (this.consent === 'unauthorized_client')
        return { redirectUri: MICROSOFT_REDIRECT, params: { error: 'unauthorized_client', state } };
      return {
        redirectUri: MICROSOFT_REDIRECT,
        params: { code: 'ms-code', state: this.consent === 'wrong_state' ? 'forged' : state },
      };
    },
    http: async (url, init) => this.token(new URL(url), new URLSearchParams(String(init.body))),
  };

  private issue(): { access_token: string; refresh_token?: string; expires_in: number; scope: string } {
    const access = `ms-access-${++this.counter}`;
    this.access.set(access, this.signedInAs);
    this.refreshToken = `ms-refresh-${this.counter}`;
    return {
      access_token: access,
      ...(this.giveRefreshToken ? { refresh_token: this.refreshToken } : {}),
      expires_in: this.expiresIn,
      scope: this.grantedScope,
    };
  }

  private async token(url: URL, body: URLSearchParams): Promise<Response> {
    if (!/^\/[\w.-]+\/oauth2\/v2\.0\/token$/.test(url.pathname) || url.host !== 'login.microsoftonline.com')
      return json(404, {});
    if (body.get('client_id') !== this.clientId) return json(400, { error: 'invalid_client' });
    if (body.has('client_secret')) return json(400, { error: 'invalid_request' });
    if (body.get('grant_type') === 'authorization_code') {
      const ok =
        body.get('code') === 'ms-code' &&
        body.get('redirect_uri') === MICROSOFT_REDIRECT &&
        b64url(
          createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest(),
        ) === this.challenge;
      return ok ? json(200, this.issue()) : json(400, { error: 'invalid_grant' });
    }
    this.refreshCalls++;
    if (this.grantGone) return json(400, { error: 'interaction_required' });
    if (body.get('refresh_token') !== this.refreshToken) return json(400, { error: 'invalid_grant' });
    return json(200, this.issue());
  }
}
