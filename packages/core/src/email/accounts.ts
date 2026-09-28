import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_EMAIL_LIMITS,
  RpcError,
  uuidv7,
  type AccountLimits,
  type AccountStatus,
  type ConnectionCheck,
  type EmailAccount,
  type GmailAccountInput,
  type ImapAccountInput,
  type Logger,
  type MailServer,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import { normalizeEmail } from '../prospects/normalize.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SecretStore } from '../secrets/secrets.js';
import type { MessageChannel } from '../channels/channel.js';
import { EmailChannel } from './email-channel.js';
import { GmailChannel } from './gmail-channel.js';
import {
  authorizeUrl,
  exchangeCode,
  GMAIL_SCOPES,
  GmailApi,
  GmailError,
  OAuthError,
  pkce,
  refreshAccessToken,
  type Http,
} from './gmail.js';
import { InboxAuthError, type InboxSource, type MailClients, type MailSettings } from './transport.js';

/** What Gmail accounts need from the outside: HTTPS, and main's OAuth loopback (ADR 016). */
export interface GmailDeps {
  http: Http;
  loopback: (
    authorizeUrl: string,
    timeoutMs: number,
  ) => Promise<{ redirectUri: string; params: Record<string, string> }>;
}

const OAUTH_TIMEOUT_MS = 10 * 60_000;

interface AccountRow {
  id: string;
  provider: 'imap_smtp' | 'gmail_api';
  display_name: string;
  external_account_id: string;
  secret_id: string | null;
  limits: string;
  status: AccountStatus;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface Metadata {
  fromName: string | null;
  smtp: MailServer | null;
  imap: MailServer | null;
  username: string | null;
  appendToSent: boolean;
  /** Gmail API accounts: the user's OAuth client. */
  clientId?: string;
  clientSecretId?: string | null;
}

const CHECK_TIMEOUT_MS = 30_000;

/** Providers whose servers keep a copy of mail sent over SMTP; others need an IMAP APPEND. */
/**
 * Exact submission hosts known to keep a Sent copy of mail sent over SMTP. Relays such as
 * smtp-relay.gmail.com do not, so a suffix match would be wrong (audit 3.5).
 */
const SAVES_SENT = new Set([
  'smtp.gmail.com',
  'smtp.googlemail.com',
  'smtp.office365.com',
  'smtp-mail.outlook.com',
]);

export function serverSavesSent(smtpHost: string): boolean {
  return SAVES_SENT.has(smtpHost.trim().toLowerCase());
}

/** A short, secret-free reason for a failed connection, for the UI (`account.<reason>`). */
function failureReason(error: unknown): string {
  const e = (error ?? {}) as { code?: string; authenticationFailed?: boolean; responseCode?: number };
  if (e.code === 'EAUTH' || e.authenticationFailed || e.responseCode === 535) return 'authFailed';
  if (e.code === 'ETLS' || e.code === 'ERR_SSL_WRONG_VERSION_NUMBER') return 'tlsFailed';
  if (e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || e.code === 'EDNS' || e.code === 'ECONNREFUSED')
    return 'unreachable';
  return 'connectionFailed';
}

/** Email accounts (docs/14): connection checks, encrypted credentials, one channel per account. */
export class AccountService {
  private readonly channels = new Map<string, { updatedAt: string; channel: MessageChannel }>();
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly secrets: SecretStore,
    private readonly clients: MailClients,
    private readonly now: () => Date,
    private readonly logger: Logger,
    /** Told when an account starts working (connected, new password) so its inbox is polled. */
    private readonly onActivated: (accountId: string) => void = () => {},
    private readonly gmail: GmailDeps = {
      http: (url, init) => fetch(url, init),
      loopback: () => Promise.reject(new RpcError('UNAVAILABLE', 'OAuth is not available')),
    },
  ) {}

  list(): EmailAccount[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM channel_accounts WHERE channel = 'email' AND status != 'disabled' ORDER BY created_at`,
      )
      .all() as unknown as AccountRow[];
    return rows.map(toDto);
  }

  get(id: string): EmailAccount {
    return toDto(this.row(id));
  }

  /** Tests SMTP and IMAP with the given password and saves the account only if both work. */
  async connectImap(input: ImapAccountInput, ctx: CommandContext): Promise<EmailAccount> {
    const address = normalizeEmail(input.address);
    if (!address) throw RpcError.validation({ address: 'email.invalid' });
    if (this.findActive(address)) throw RpcError.validation({ address: 'account.duplicate' });
    const settings: MailSettings = {
      address,
      username: input.username,
      password: input.password,
      smtp: input.smtp,
      imap: input.imap,
    };
    const check = await this.check(settings);
    if (!check.smtp.ok || !check.imap.ok) {
      const fields: Record<string, string> = {};
      if (!check.smtp.ok)
        fields[check.smtp.error === 'authFailed' ? 'password' : 'smtp.host'] = `account.${check.smtp.error}`;
      if (!check.imap.ok)
        fields[check.imap.error === 'authFailed' ? 'password' : 'imap.host'] = `account.${check.imap.error}`;
      throw RpcError.validation(fields, 'account.connectionFailed');
    }
    const secretId = await this.secrets.put('imap_password', input.password);
    return transaction(this.db, () => {
      if (this.findActive(address)) {
        this.secrets.delete(secretId);
        throw RpcError.validation({ address: 'account.duplicate' });
      }
      const id = uuidv7();
      const ts = this.now().toISOString();
      const metadata: Metadata = {
        fromName: input.fromName?.trim() || null,
        smtp: input.smtp,
        imap: input.imap,
        username: input.username,
        appendToSent: input.appendToSent ?? !serverSavesSent(input.smtp.host),
      };
      this.db
        .prepare(
          `INSERT INTO channel_accounts (id, channel, provider, display_name, external_account_id, secret_id, limits,
                                         status, metadata, created_at, updated_at)
           VALUES (?, 'email', 'imap_smtp', ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          input.displayName?.trim() || address,
          address,
          secretId,
          JSON.stringify(input.limits ?? DEFAULT_EMAIL_LIMITS),
          JSON.stringify(metadata),
          ts,
          ts,
        );
      this.record('account.connected', id, ctx, {
        provider: 'imap_smtp',
        sentFolder: check.imap.sentFolder !== null,
      });
      this.onActivated(id);
      return this.get(id);
    });
  }

  /**
   * Connects a Gmail account through the user's own OAuth client (ADR 016, options A/B): the
   * consent page opens in the system browser; main carries the loopback redirect back; PKCE and
   * `state` are checked here. Only the refresh token is stored, encrypted.
   */
  async connectGmail(input: GmailAccountInput, ctx: CommandContext): Promise<EmailAccount> {
    const { verifier, challenge, state } = pkce();
    const clientSecret = input.clientSecret?.trim() || null;
    let redirect: { redirectUri: string; params: Record<string, string> };
    try {
      redirect = await this.gmail.loopback(authorizeUrl(input.clientId, challenge, state), OAUTH_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn({ event: 'gmail.oauth_aborted', err: error }, 'OAuth did not complete');
      throw new RpcError('CONFLICT', 'Authorization was not completed', 'oauth.notCompleted');
    }
    const { params } = redirect;
    if (params.state !== state) throw new RpcError('CONFLICT', 'OAuth state mismatch', 'oauth.stateMismatch');
    if (params.error || !params.code) {
      throw new RpcError(
        'CONFLICT',
        'Authorization was declined',
        params.error === 'access_denied' ? 'oauth.denied' : 'oauth.notCompleted',
      );
    }
    let tokens;
    try {
      tokens = await exchangeCode(this.gmail.http, {
        clientId: input.clientId,
        clientSecret,
        code: params.code,
        verifier,
        redirectUri: redirect.redirectUri,
      });
    } catch (error) {
      const kind = error instanceof OAuthError ? error.kind : 'other';
      this.logger.warn({ event: 'gmail.token_exchange_failed', kind }, 'token exchange failed');
      throw RpcError.validation(
        kind === 'invalid_client' ? { clientSecret: 'oauth.invalidClient' } : {},
        kind === 'invalid_client' ? 'oauth.invalidClient' : 'oauth.exchangeFailed',
      );
    }
    const granted = tokens.scope.split(/\s+/);
    if (!GMAIL_SCOPES.every((scope) => granted.includes(scope))) {
      throw new RpcError('CONFLICT', 'Not all permissions were granted', 'oauth.scopesMissing');
    }
    if (!tokens.refreshToken) throw new RpcError('CONFLICT', 'No refresh token', 'oauth.noRefreshToken');
    const api = new GmailApi(this.gmail.http, async () => tokens.accessToken);
    const profile = await api.profile(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    const address = normalizeEmail(profile.emailAddress);
    if (!address) throw new RpcError('CONFLICT', 'Gmail returned no address', 'oauth.exchangeFailed');
    const existing = this.findActive(address);
    if (existing && existing.provider !== 'gmail_api') {
      throw RpcError.validation({ address: 'account.duplicate' }, 'account.duplicate');
    }
    const refreshId = await this.secrets.put('oauth_refresh_token', tokens.refreshToken);
    const secretId = clientSecret ? await this.secrets.put('oauth_client_secret', clientSecret) : null;
    if (existing)
      return this.renewGmail(existing, { clientId: input.clientId, refreshId, secretId, tokens }, ctx);
    return transaction(this.db, () => {
      const id = uuidv7();
      const ts = this.now().toISOString();
      const metadata: Metadata = {
        fromName: input.fromName?.trim() || null,
        smtp: null,
        imap: null,
        username: null,
        appendToSent: false,
        clientId: input.clientId,
        clientSecretId: secretId,
      };
      this.db
        .prepare(
          `INSERT INTO channel_accounts (id, channel, provider, display_name, external_account_id, secret_id, limits,
                                         status, metadata, created_at, updated_at)
           VALUES (?, 'email', 'gmail_api', ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          id,
          address,
          address,
          refreshId,
          JSON.stringify(input.limits ?? DEFAULT_EMAIL_LIMITS),
          JSON.stringify(metadata),
          ts,
          ts,
        );
      // Replies are read from now on: start the history cursor at the current position.
      this.db
        .prepare(
          `INSERT INTO mailbox_cursors (channel_account_id, folder, uid_validity, last_uid) VALUES (?, 'INBOX', 0, ?)`,
        )
        .run(id, Number(profile.historyId));
      this.tokens.set(id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
      this.record('account.connected', id, ctx, { provider: 'gmail_api' });
      this.onActivated(id);
      return this.get(id);
    });
  }

  /** Signing in again to a connected Gmail account (e.g. after the token was revoked): new tokens, same account. */
  private renewGmail(
    row: AccountRow,
    fresh: {
      clientId: string;
      refreshId: string;
      secretId: string | null;
      tokens: { accessToken: string; expiresAt: number };
    },
    ctx: CommandContext,
  ): EmailAccount {
    return transaction(this.db, () => {
      const m = JSON.parse(row.metadata) as Metadata;
      const old = [row.secret_id, m.clientSecretId].filter((x): x is string => Boolean(x));
      this.db
        .prepare(
          `UPDATE channel_accounts SET secret_id = ?, metadata = ?, status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(
          fresh.refreshId,
          JSON.stringify({ ...m, clientId: fresh.clientId, clientSecretId: fresh.secretId }),
          this.now().toISOString(),
          row.id,
        );
      for (const id of old) this.secrets.delete(id);
      this.tokens.set(row.id, { token: fresh.tokens.accessToken, expiresAt: fresh.tokens.expiresAt });
      this.record('account.updated', row.id, ctx, { fields: ['oauth'] });
      this.onActivated(row.id);
      return this.get(row.id);
    });
  }

  async update(
    input: {
      id: string;
      displayName?: string | undefined;
      fromName?: string | null | undefined;
      limits?: AccountLimits | undefined;
      password?: string | undefined;
    },
    ctx: CommandContext,
  ): Promise<EmailAccount> {
    const row = this.row(input.id);
    let secretId: string | null = null;
    if (input.password !== undefined) {
      if (row.provider !== 'imap_smtp')
        throw new RpcError('CONFLICT', 'This account has no password', 'account.noPassword');
      const settings = { ...(await this.settingsOf(row, false)), password: input.password };
      const check = await this.check(settings);
      if (!check.smtp.ok || !check.imap.ok) {
        throw RpcError.validation(
          { password: `account.${check.smtp.error ?? check.imap.error ?? 'connectionFailed'}` },
          'account.connectionFailed',
        );
      }
      secretId = await this.secrets.put('imap_password', input.password);
    }
    return transaction(this.db, () => {
      const current = this.row(input.id);
      const metadata = JSON.parse(current.metadata) as Metadata;
      if (input.fromName !== undefined) metadata.fromName = input.fromName?.trim() || null;
      const fields: string[] = [];
      if (input.displayName !== undefined) fields.push('displayName');
      if (input.fromName !== undefined) fields.push('fromName');
      if (input.limits !== undefined) fields.push('limits');
      if (secretId) fields.push('password');
      this.db
        .prepare(
          `UPDATE channel_accounts SET display_name = ?, limits = ?, metadata = ?, secret_id = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.displayName ?? current.display_name,
          input.limits ? JSON.stringify(input.limits) : current.limits,
          JSON.stringify(metadata),
          secretId ?? current.secret_id,
          secretId ? 'active' : current.status,
          this.now().toISOString(),
          current.id,
        );
      if (secretId && current.secret_id) this.secrets.delete(current.secret_id);
      this.record('account.updated', current.id, ctx, { fields });
      if (secretId) this.onActivated(current.id);
      return this.get(current.id);
    });
  }

  async test(id: string): Promise<ConnectionCheck> {
    const row = this.row(id);
    if (row.provider === 'gmail_api') {
      try {
        await (await this.gmailApi(row)).profile(AbortSignal.timeout(CHECK_TIMEOUT_MS));
        return { smtp: { ok: true }, imap: { ok: true, sentFolder: 'SENT' } };
      } catch (error) {
        const auth =
          error instanceof OAuthError ||
          (error instanceof GmailError && (error.status === 401 || error.status === 403));
        if (auth) this.markAuthRequired(id);
        const reason = auth ? 'authFailed' : 'connectionFailed';
        return { smtp: { ok: false, error: reason }, imap: { ok: false, error: reason, sentFolder: null } };
      }
    }
    return this.check(await this.settingsOf(row, true));
  }

  disconnect(id: string, ctx: CommandContext): void {
    transaction(this.db, () => {
      const row = this.row(id);
      this.db
        .prepare(
          `UPDATE channel_accounts SET status = 'disabled', secret_id = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(this.now().toISOString(), id);
      if (row.secret_id) this.secrets.delete(row.secret_id);
      const clientSecretId = (JSON.parse(row.metadata) as Metadata).clientSecretId;
      if (clientSecretId) this.secrets.delete(clientSecretId);
      this.channels.delete(id);
      this.tokens.delete(id);
      this.record('account.disconnected', id, ctx);
    });
  }

  /** The sending channel of an active account, or undefined (unknown, disconnected, needs a new password). */
  channel(accountId: string | null | undefined): MessageChannel | undefined {
    if (!accountId) return undefined;
    const row = this.db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(accountId) as
      AccountRow | undefined;
    if (!row || row.status !== 'active') return undefined;
    const cached = this.channels.get(row.id);
    if (cached?.updatedAt === row.updated_at) return cached.channel;
    const dto = toDto(row);
    if (row.provider === 'gmail_api') {
      const gmail = new GmailChannel(
        {
          id: row.id,
          address: dto.address,
          fromName: dto.fromName,
          minSpacingMs: dto.limits.minSpacingSeconds * 1000,
          dailyLimit: dto.limits.dailyLimit,
        },
        () => this.gmailApi(row),
        this.now,
        this.logger.child({ accountId: row.id }),
        () => this.markAuthRequired(row.id),
      );
      this.channels.set(row.id, { updatedAt: row.updated_at, channel: gmail });
      return gmail;
    }
    const channel = new EmailChannel(
      {
        id: row.id,
        address: dto.address,
        fromName: dto.fromName,
        minSpacingMs: dto.limits.minSpacingSeconds * 1000,
        dailyLimit: dto.limits.dailyLimit,
        appendToSent: dto.appendToSent,
      },
      () => this.settingsOf(row, true),
      this.clients,
      this.now,
      this.logger.child({ accountId: row.id }),
      () => this.markAuthRequired(row.id),
    );
    this.channels.set(row.id, { updatedAt: row.updated_at, channel });
    return channel;
  }

  /**
   * The account's inbox for reply ingestion (ADR 024), IMAP or Gmail history. Throws
   * `InboxAuthError` when the provider refuses the stored credentials.
   */
  async openInbox(id: string, signal: AbortSignal): Promise<InboxSource> {
    const row = this.row(id);
    if (row.provider === 'gmail_api') {
      const api = await this.gmailApi(row).catch((error: unknown) => {
        throw error instanceof OAuthError && error.kind === 'invalid_grant'
          ? new InboxAuthError('Refresh token refused')
          : error;
      });
      return gmailInbox(api);
    }
    const settings = await this.settingsOf(row, true);
    let box;
    try {
      box = await this.clients.mailbox(settings, signal);
    } catch (error) {
      if ((error as { authenticationFailed?: boolean }).authenticationFailed)
        throw new InboxAuthError('IMAP login refused');
      throw error;
    }
    return imapInbox(box);
  }

  addressOf(id: string): string | null {
    const row = this.db.prepare('SELECT external_account_id FROM channel_accounts WHERE id = ?').get(id) as
      { external_account_id: string } | undefined;
    return row?.external_account_id ?? null;
  }

  /** The server refused the stored password: stop using the account until the user fixes it. */
  markAuthRequired(id: string): void {
    this.db
      .prepare(
        `UPDATE channel_accounts SET status = 'auth_required', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(this.now().toISOString(), id);
    this.logger.warn({ event: 'account.auth_required', accountId: id }, 'email account needs a new password');
  }

  /** A Gmail client with a cached access token, refreshed from the stored refresh token. */
  private async gmailApi(row: AccountRow): Promise<GmailApi> {
    const m = JSON.parse(row.metadata) as Metadata;
    if (!m.clientId || !row.secret_id)
      throw new RpcError('CONFLICT', 'Account has no OAuth client', 'account.noPassword');
    const refreshId = row.secret_id;
    const clientId = m.clientId;
    const token = async (force = false): Promise<string> => {
      const cached = this.tokens.get(row.id);
      if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const refreshToken = await this.secrets.reveal(refreshId);
      const clientSecret = m.clientSecretId ? await this.secrets.reveal(m.clientSecretId) : null;
      try {
        const fresh = await refreshAccessToken(this.gmail.http, { clientId, clientSecret, refreshToken });
        this.tokens.set(row.id, { token: fresh.accessToken, expiresAt: fresh.expiresAt });
        return fresh.accessToken;
      } catch (error) {
        if (error instanceof OAuthError && error.kind === 'invalid_grant') this.markAuthRequired(row.id);
        throw error;
      }
    };
    return new GmailApi(this.gmail.http, token);
  }

  private async check(settings: MailSettings): Promise<ConnectionCheck> {
    const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
    const result: ConnectionCheck = { smtp: { ok: false }, imap: { ok: false, sentFolder: null } };
    const smtp = this.clients.smtp(settings);
    try {
      await smtp.verify(signal);
      result.smtp = { ok: true };
    } catch (error) {
      result.smtp = { ok: false, error: failureReason(error) };
      this.logger.warn(
        { event: 'account.smtp_check_failed', reason: result.smtp.error },
        'SMTP check failed',
      );
    } finally {
      smtp.close();
    }
    try {
      const box = await this.clients.mailbox(settings, signal);
      try {
        result.imap = { ok: true, sentFolder: await box.sentFolder(signal) };
      } finally {
        await box.close();
      }
    } catch (error) {
      result.imap = { ok: false, error: failureReason(error), sentFolder: null };
      this.logger.warn(
        { event: 'account.imap_check_failed', reason: result.imap.error },
        'IMAP check failed',
      );
    }
    return result;
  }

  private async settingsOf(row: AccountRow, withPassword: boolean): Promise<MailSettings> {
    const m = JSON.parse(row.metadata) as Metadata;
    if (!m.smtp || !m.imap || !m.username)
      throw new RpcError('CONFLICT', 'Account has no mail servers', 'account.notImap');
    let password = '';
    if (withPassword) {
      if (!row.secret_id) throw new RpcError('CONFLICT', 'Account has no password', 'account.noPassword');
      password = await this.secrets.reveal(row.secret_id);
    }
    return { address: row.external_account_id, username: m.username, password, smtp: m.smtp, imap: m.imap };
  }

  private findActive(address: string): AccountRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM channel_accounts WHERE channel = 'email' AND external_account_id = ? AND status != 'disabled'`,
      )
      .get(address) as AccountRow | undefined;
  }

  private row(id: string): AccountRow {
    const row = this.db
      .prepare(`SELECT * FROM channel_accounts WHERE id = ? AND channel = 'email'`)
      .get(id) as AccountRow | undefined;
    if (!row || row.status === 'disabled')
      throw new RpcError('NOT_FOUND', 'Account not found', 'account.notFound');
    return row;
  }

  private record(
    actionType: 'account.connected' | 'account.updated' | 'account.disconnected',
    id: string,
    ctx: CommandContext,
    payload: Record<string, unknown> = {},
  ): void {
    this.audit.record({
      actorType: 'user',
      actionType,
      objectType: 'account',
      objectId: id,
      payload,
      correlationId: ctx.correlationId,
    });
  }
}

function toDto(r: AccountRow): EmailAccount {
  const m = JSON.parse(r.metadata) as Metadata;
  return {
    id: r.id,
    provider: r.provider,
    address: r.external_account_id,
    displayName: r.display_name,
    fromName: m.fromName,
    status: r.status,
    limits: JSON.parse(r.limits) as AccountLimits,
    smtp: m.smtp,
    imap: m.imap,
    username: m.username,
    appendToSent: m.appendToSent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function imapInbox(box: Awaited<ReturnType<MailClients['mailbox']>>): InboxSource {
  return {
    async fetchNew(cursor, limit, signal) {
      const batch = await box.fetchNew('INBOX', { uidValidity: cursor.a, lastUid: cursor.b }, limit, signal);
      return {
        cursor: { a: batch.uidValidity, b: batch.lastUid },
        messages: batch.messages.map((m) => ({
          providerId: `${batch.uidValidity}:${m.uid}`,
          load: () => Promise.resolve(m.raw),
          cursor: { a: batch.uidValidity, b: m.uid },
        })),
        more: batch.messages.length >= limit,
      };
    },
    close: () => box.close(),
  };
}

/** Gmail: cursor `a` is 0, `b` the history id; message ids dedupe replays (ADR 024). */
function gmailInbox(api: GmailApi): InboxSource {
  return {
    async fetchNew(cursor, limit, signal) {
      if (cursor.b === null) {
        const { historyId } = await api.profile(signal);
        return { cursor: { a: 0, b: Number(historyId) }, messages: [], more: false };
      }
      let since;
      try {
        since = await api.inboxSince(String(cursor.b), signal);
      } catch (error) {
        if (
          error instanceof OAuthError ||
          (error instanceof GmailError && (error.status === 401 || error.status === 403))
        ) {
          throw new InboxAuthError('Gmail refused the credentials');
        }
        throw error;
      }
      const batch = since.added.slice(0, limit);
      const more = since.added.length > batch.length;
      return {
        // Each message carries the position after it; a partial batch continues from there.
        cursor: { a: 0, b: more ? Number(batch.at(-1)?.historyId ?? cursor.b) : Number(since.historyId) },
        messages: batch.map((m) => ({
          providerId: `gmail:${m.messageId}`,
          load: () => api.raw(m.messageId, signal),
          cursor: { a: 0, b: Number(m.historyId) },
        })),
        more,
        ...(since.expired ? { warning: 'historyExpired' as const } : {}),
      };
    },
    close: async () => {},
  };
}
