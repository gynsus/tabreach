import type { MailServer } from '@tabreach/protocol';
import type { Http } from './gmail.js';
import { tokenRequest, type TokenSet } from './oauth.js';

/**
 * Microsoft sign-in for IMAP/SMTP (ADR 032): the user's own app registration in Microsoft Entra
 * (a public client, so no secret), the authorization code flow with PKCE, and XOAUTH2 to
 * Exchange Online / Outlook.com.
 */

const LOGIN = 'https://login.microsoftonline.com';

/** What the mail servers need; `offline_access` adds the refresh token. */
export const MICROSOFT_MAIL_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
];
const REQUESTED_SCOPES = ['offline_access', ...MICROSOFT_MAIL_SCOPES].join(' ');

/** Outlook.com and Microsoft 365 share these servers. */
export const MICROSOFT_SERVERS: { smtp: MailServer; imap: MailServer } = {
  smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
  imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
};

export interface MicrosoftClient {
  clientId: string;
  /** `common` (work, school and personal accounts), `organizations`, `consumers`, or one directory. */
  tenant: string;
}

const endpoint = (tenant: string, path: 'authorize' | 'token') =>
  `${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/${path}`;

/** The consent URL, without `redirect_uri`: main adds its loopback address. */
export function microsoftAuthorizeUrl(
  client: MicrosoftClient,
  o: { challenge: string; state: string; loginHint: string },
): string {
  const url = new URL(endpoint(client.tenant, 'authorize'));
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', REQUESTED_SCOPES);
  url.searchParams.set('code_challenge', o.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', o.state);
  // The mailbox being connected; the person can still pick another account on the page.
  url.searchParams.set('login_hint', o.loginHint);
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export function microsoftExchangeCode(
  http: Http,
  client: MicrosoftClient,
  o: { code: string; verifier: string; redirectUri: string },
): Promise<TokenSet> {
  return tokenRequest(http, endpoint(client.tenant, 'token'), {
    grant_type: 'authorization_code',
    client_id: client.clientId,
    scope: REQUESTED_SCOPES,
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
  });
}

/** A new access token; Microsoft usually returns a new refresh token too, which replaces the old one. */
export function microsoftRefresh(
  http: Http,
  client: MicrosoftClient,
  refreshToken: string,
): Promise<TokenSet> {
  return tokenRequest(http, endpoint(client.tenant, 'token'), {
    grant_type: 'refresh_token',
    client_id: client.clientId,
    scope: REQUESTED_SCOPES,
    refresh_token: refreshToken,
  });
}

/**
 * Whether both mail permissions were granted. Microsoft names them with or without the resource
 * prefix; an empty answer leaves the decision to the IMAP and SMTP check that follows.
 */
export function grantedMailScopes(scope: string): boolean {
  if (!scope.trim()) return true;
  const granted = scope.toLowerCase().split(/\s+/);
  return ['imap.accessasuser.all', 'smtp.send'].every((name) =>
    granted.some((g) => g === name || g.endsWith(`/${name}`)),
  );
}
