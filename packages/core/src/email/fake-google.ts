import { createHash } from 'node:crypto';
import type { GmailDeps } from './accounts.js';

type SendBehaviour =
  'ok' | 'server_error_after_storing' | 'server_error' | 'unreachable' | 'bad_request' | 'hang';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * Google's OAuth token endpoint and the Gmail API, in memory. Checks PKCE and bearer tokens, so
 * tests fail if the code sends the wrong verifier or an expired token.
 */
export class FakeGoogle {
  address = 'me@gmail.com';
  grantedScope = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly';
  /** What the user does on the consent page. */
  consent: 'allow' | 'deny' | 'wrong_state' = 'allow';
  refreshRevoked = false;
  readonly sent: { id: string; raw: string; messageId: string }[] = [];
  readonly inbox: { id: string; raw: string; historyId: number }[] = [];
  historyId = 100;
  /** History older than this is gone (Gmail keeps about a week). */
  oldestHistory = 0;
  sendCalls = 0;
  private challenge = '';
  private accessToken = '';
  private tokenCounter = 0;
  private readonly next: SendBehaviour[] = [];

  queue(...b: SendBehaviour[]): void {
    this.next.push(...b);
  }

  /** A message arrives in the inbox. */
  receive(raw: string): void {
    this.historyId++;
    this.inbox.push({
      id: `in-${this.historyId}`,
      raw: raw.replace(/\r?\n/g, '\r\n'),
      historyId: this.historyId,
    });
  }

  /** The current access token stops working (expiry). */
  expireAccessToken(): void {
    this.accessToken = 'expired';
  }

  readonly deps: GmailDeps = {
    loopback: async (authorizeUrl) => {
      const url = new URL(authorizeUrl);
      this.challenge = url.searchParams.get('code_challenge') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const redirectUri = 'http://127.0.0.1:53682';
      if (this.consent === 'deny') return { redirectUri, params: { error: 'access_denied', state } };
      return {
        redirectUri,
        params: { code: 'the-code', state: this.consent === 'wrong_state' ? 'forged' : state },
      };
    },
    http: async (url, init) => this.handle(new URL(url), init),
  };

  private issueToken(): string {
    this.accessToken = `access-${++this.tokenCounter}`;
    return this.accessToken;
  }

  private async handle(url: URL, init: RequestInit): Promise<Response> {
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init.body));
      if (body.get('grant_type') === 'authorization_code') {
        const verifier = body.get('code_verifier') ?? '';
        const ok =
          body.get('code') === 'the-code' &&
          body.get('redirect_uri') === 'http://127.0.0.1:53682' &&
          b64url(createHash('sha256').update(verifier).digest()) === this.challenge;
        if (!ok) return json(400, { error: 'invalid_grant' });
        return json(200, {
          access_token: this.issueToken(),
          refresh_token: 'refresh-1',
          expires_in: 3599,
          scope: this.grantedScope,
        });
      }
      if (this.refreshRevoked || body.get('refresh_token') !== 'refresh-1')
        return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: this.issueToken(), expires_in: 3599, scope: this.grantedScope });
    }
    const auth = new Headers(init.headers).get('authorization');
    if (auth !== `Bearer ${this.accessToken}`) return json(401, { error: { code: 401 } });
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/profile')
      return json(200, { emailAddress: this.address, historyId: String(this.historyId) });
    if (path === '/messages/send' && init.method === 'POST')
      return this.send(JSON.parse(String(init.body)) as { raw: string });
    if (path === '/messages') {
      const id = (url.searchParams.get('q') ?? '').replace('rfc822msgid:', '');
      const found = this.sent.filter((m) => m.messageId === `<${id}>`);
      return json(
        200,
        found.length ? { messages: found.map((m) => ({ id: m.id })) } : { resultSizeEstimate: 0 },
      );
    }
    if (path === '/history') {
      const start = Number(url.searchParams.get('startHistoryId'));
      if (start < this.oldestHistory) return json(404, { error: { code: 404 } });
      const added = this.inbox.filter((m) => m.historyId > start);
      return json(200, {
        historyId: String(this.historyId),
        history: added.map((m) => ({ messagesAdded: [{ message: { id: m.id, labelIds: ['INBOX'] } }] })),
      });
    }
    const raw = /^\/messages\/([^/]+)$/.exec(path);
    if (raw) {
      const m = this.inbox.find((x) => x.id === raw[1]);
      return m ? json(200, { raw: b64url(Buffer.from(m.raw)) }) : json(404, {});
    }
    return json(404, {});
  }

  private async send(body: { raw: string }): Promise<Response> {
    this.sendCalls++;
    const behaviour = this.next.shift() ?? 'ok';
    if (behaviour === 'unreachable')
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (behaviour === 'bad_request') return json(400, { error: { code: 400, message: 'Invalid To header' } });
    if (behaviour === 'server_error') return json(500, {});
    const raw = Buffer.from(body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const messageId = /^Message-ID:\s*(<[^>]+>)/im.exec(raw)?.[1] ?? '';
    const id = `sent-${this.sent.length + 1}`;
    this.sent.push({ id, raw, messageId });
    if (behaviour === 'hang') return new Promise<never>(() => {});
    if (behaviour === 'server_error_after_storing') return json(500, {});
    return json(200, { id, threadId: `t-${id}` });
  }
}
