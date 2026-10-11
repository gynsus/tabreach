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
  type MicrosoftAccountInput,
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
  revokeToken,
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
import {
  grantedMailScopes,
  MICROSOFT_SERVERS,
  microsoftAuthorizeUrl,
  microsoftExchangeCode,
  microsoftRefresh,
  type MicrosoftClient,
} from './microsoft.js';
import {
  InboxAuthError,
  MAX_WHOLE_MESSAGE_BYTES,
  PARTIAL_MESSAGE_BYTES,
  type InboxSource,
  type MailClients,
  type MailSettings,
} from './transport.js';

/** What OAuth accounts need from the outside: HTTPS, and main's OAuth loopback (ADR 016, ADR 032). */
export interface OAuthDeps {
  http: Http;
  loopback: (
    authorizeUrl: string,
    timeoutMs: number,
    state: string,
  ) => Promise<{ redirectUri: string; params: Record<string, string> }>;
}

const OAUTH_TIMEOUT_MS = 10 * 60_000;
/** An access token this close to expiry is renewed first, so it cannot run out mid-session. */
const TOKEN_MARGIN_MS = 5 * 60_000;

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
  /** IMAP/SMTP accounts that sign in with Microsoft (XOAUTH2, ADR 032) instead of a password. */
  oauth?: { provider: 'microsoft'; clientId: string; tenant: string };
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
  /** One Microsoft token refresh at a time per account: each may hand out a new refresh token. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly secrets: SecretStore,
    private readonly clients: MailClients,
    private readonly now: () => Date,
    private readonly logger: Logger,
    /** Told when an account starts working (connected, new password) so its inbox is polled. */
    private readonly onActivated: (accountId: string) => void = () => {},
    private readonly oauth: OAuthDeps = {
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
    return this.orDropSecrets([secretId], () =>
      transaction(this.db, () => {
        if (this.findActive(address)) {
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
      }),
    );
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
      redirect = await this.oauth.loopback(
        authorizeUrl(input.clientId, challenge, state),
        OAUTH_TIMEOUT_MS,
        state,
      );
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
      tokens = await exchangeCode(this.oauth.http, {
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
    const api = new GmailApi(this.oauth.http, async () => tokens.accessToken);
    const profile = await api.profile(AbortSignal.timeout(CHECK_TIMEOUT_MS));
    const address = normalizeEmail(profile.emailAddress);
    if (!address) throw new RpcError('CONFLICT', 'Gmail returned no address', 'oauth.exchangeFailed');
    const existing = this.findActive(address);
    if (existing && existing.provider !== 'gmail_api') {
      throw RpcError.validation({ address: 'account.duplicate' }, 'account.duplicate');
    }
    const refreshId = await this.secrets.put('oauth_refresh_token', tokens.refreshToken);
    const secretId = clientSecret ? await this.secrets.put('oauth_client_secret', clientSecret) : null;
    if (existing) {
      return this.orDropSecrets([refreshId, secretId], () =>
        this.renewOAuth(
          existing,
          {
            refreshId,
            metadata: (m) => ({ ...m, clientId: input.clientId, clientSecretId: secretId }),
            tokens,
          },
          ctx,
        ),
      );
    }
    return this.orDropSecrets([refreshId, secretId], () =>
      transaction(this.db, () => {
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
      }),
    );
  }

  /**
   * Signing in again to a connected OAuth account (e.g. after the grant was revoked): new tokens,
   * same account. The secrets the account held before are deleted.
   */
  private renewOAuth(
    row: AccountRow,
    fresh: {
      refreshId: string;
      metadata: (m: Metadata) => Metadata;
      tokens: { accessToken: string; expiresAt: number };
    },
    ctx: CommandContext,
  ): EmailAccount {
    return transaction(this.db, () => {
      const current = this.row(row.id);
      const m = JSON.parse(current.metadata) as Metadata;
      const old = [current.secret_id, m.clientSecretId].filter((x): x is string => Boolean(x));
      const next = fresh.metadata(m);
      this.db
        .prepare(
          `UPDATE channel_accounts SET secret_id = ?, metadata = ?, status = 'active', updated_at = ? WHERE id = ?`,
        )
        .run(fresh.refreshId, JSON.stringify(next), this.now().toISOString(), row.id);
      for (const id of old) if (id !== next.clientSecretId) this.secrets.delete(id);
      this.tokens.set(row.id, { token: fresh.tokens.accessToken, expiresAt: fresh.tokens.expiresAt });
      this.record('account.updated', row.id, ctx, { fields: ['oauth'] });
      this.onActivated(row.id);
      return this.get(row.id);
    });
  }

  /**
   * Connects an Outlook.com or Microsoft 365 mailbox over IMAP/SMTP with Microsoft sign-in
   * (ADR 032): the user's own Entra app registration, PKCE, the loopback redirect through main,
   * then SMTP and IMAP are tested with the token. Only the refresh token is stored, encrypted;
   * signing in again to the same address renews the account.
   */
  async connectMicrosoft(input: MicrosoftAccountInput, ctx: CommandContext): Promise<EmailAccount> {
    const address = normalizeEmail(input.address);
    if (!address) throw RpcError.validation({ address: 'email.invalid' });
    const existing = this.findActive(address);
    if (existing && (JSON.parse(existing.metadata) as Metadata).oauth?.provider !== 'microsoft') {
      throw RpcError.validation({ address: 'account.duplicate' }, 'account.duplicate');
    }
    const client: MicrosoftClient = { clientId: input.clientId, tenant: input.tenant ?? 'common' };
    const { verifier, challenge, state } = pkce();
    let redirect: { redirectUri: string; params: Record<string, string> };
    try {
      redirect = await this.oauth.loopback(
        microsoftAuthorizeUrl(client, { challenge, state, loginHint: address }),
        OAUTH_TIMEOUT_MS,
        state,
      );
    } catch (error) {
      this.logger.warn({ event: 'microsoft.oauth_aborted', err: error }, 'OAuth did not complete');
      throw new RpcError('CONFLICT', 'Authorization was not completed', 'oauth.notCompleted');
    }
    const { params } = redirect;
    if (params.state !== state) throw new RpcError('CONFLICT', 'OAuth state mismatch', 'oauth.stateMismatch');
    if (params.error || !params.code) {
      // The error code only: Microsoft's description may name the account.
      this.logger.warn({ event: 'microsoft.oauth_refused', error: params.error ?? null }, 'sign-in refused');
      const key =
        params.error === 'access_denied'
          ? 'oauth.denied'
          : params.error === 'unauthorized_client' || params.error === 'invalid_client'
            ? 'oauth.microsoftClient'
            : 'oauth.notCompleted';
      throw new RpcError('CONFLICT', 'Authorization was not completed', key);
    }
    let tokens;
    try {
      tokens = await microsoftExchangeCode(this.oauth.http, client, {
        code: params.code,
        verifier,
        redirectUri: redirect.redirectUri,
      });
    } catch (error) {
      const kind = error instanceof OAuthError ? error.kind : 'other';
      this.logger.warn({ event: 'microsoft.token_exchange_failed', kind }, 'token exchange failed');
      throw RpcError.validation(
        kind === 'invalid_client' ? { clientId: 'oauth.microsoftClient' } : {},
        kind === 'invalid_client' ? 'oauth.microsoftClient' : 'oauth.exchangeFailed',
      );
    }
    if (!grantedMailScopes(tokens.scope)) {
      throw new RpcError('CONFLICT', 'Not all permissions were granted', 'oauth.scopesMissing');
    }
    if (!tokens.refreshToken) throw new RpcError('CONFLICT', 'No refresh token', 'oauth.noRefreshToken');
    const settings: MailSettings = {
      address,
      username: address,
      password: '',
      accessToken: tokens.accessToken,
      ...MICROSOFT_SERVERS,
    };
    const check = await this.check(settings);
    if (!check.smtp.ok || !check.imap.ok) {
      // Signed in, but a server refused the token: another account was chosen on the sign-in
      // page, or IMAP / authenticated SMTP is switched off for this mailbox.
      const refused = check.smtp.error === 'authFailed' || check.imap.error === 'authFailed';
      throw RpcError.validation(
        refused ? { address: 'account.oauthRefused' } : {},
        refused ? 'account.oauthRefused' : 'account.connectionFailed',
      );
    }
    const refreshId = await this.secrets.put('oauth_refresh_token', tokens.refreshToken);
    const oauth = { provider: 'microsoft' as const, clientId: client.clientId, tenant: client.tenant };
    if (existing) {
      return this.orDropSecrets([refreshId], () =>
        this.renewOAuth(existing, { refreshId, metadata: (m) => ({ ...m, oauth }), tokens }, ctx),
      );
    }
    return this.orDropSecrets([refreshId], () =>
      transaction(this.db, () => {
        if (this.findActive(address)) throw RpcError.validation({ address: 'account.duplicate' });
        const id = uuidv7();
        const ts = this.now().toISOString();
        const metadata: Metadata = {
          fromName: input.fromName?.trim() || null,
          ...MICROSOFT_SERVERS,
          username: address,
          appendToSent: !serverSavesSent(MICROSOFT_SERVERS.smtp.host),
          oauth,
        };
        this.db
          .prepare(
            `INSERT INTO channel_accounts (id, channel, provider, display_name, external_account_id, secret_id, limits,
                                         status, metadata, created_at, updated_at)
           VALUES (?, 'email', 'imap_smtp', ?, ?, ?, ?, 'active', ?, ?, ?)`,
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
        this.tokens.set(id, { token: tokens.accessToken, expiresAt: tokens.expiresAt });
        this.record('account.connected', id, ctx, {
          provider: 'imap_smtp',
          signIn: 'microsoft',
          sentFolder: check.imap.sentFolder !== null,
        });
        this.onActivated(id);
        return this.get(id);
      }),
    );
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
      if (row.provider !== 'imap_smtp' || (JSON.parse(row.metadata) as Metadata).oauth)
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
    return this.orDropSecrets([secretId], () =>
      transaction(this.db, () => {
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
      }),
    );
  }

  async test(id: string): Promise<ConnectionCheck> {
    const row = this.row(id);
    if (row.provider === 'gmail_api') {
      try {
        await (await this.gmailApi(row)).profile(AbortSignal.timeout(CHECK_TIMEOUT_MS));
        return { smtp: { ok: true }, imap: { ok: true, sentFolder: 'SENT' } };
      } catch (error) {
        const auth = error instanceof OAuthError || (error instanceof GmailError && error.isAuth);
        if (auth) this.markAuthRequired(id);
        const reason = auth ? 'authFailed' : 'connectionFailed';
        return { smtp: { ok: false, error: reason }, imap: { ok: false, error: reason, sentFolder: null } };
      }
    }
    let settings: MailSettings;
    try {
      settings = await this.settingsOf(row, true);
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      // Microsoft sign-in could not renew the token: no server was asked.
      const reason = error.kind === 'invalid_grant' ? 'authFailed' : 'connectionFailed';
      return { smtp: { ok: false, error: reason }, imap: { ok: false, error: reason, sentFolder: null } };
    }
    return this.check(settings);
  }

  async disconnect(id: string, ctx: CommandContext): Promise<void> {
    const before = this.row(id);
    // Gmail: read the refresh token before its secret is deleted, to revoke the grant at Google.
    const refreshToken =
      before.provider === 'gmail_api' && before.secret_id
        ? await this.secrets.reveal(before.secret_id).catch((error: unknown) => {
            this.logger.warn(
              { event: 'gmail.revoke_skipped', accountId: id, err: error },
              'could not read the token to revoke',
            );
            return null;
          })
        : null;
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
    if (refreshToken) {
      // Best effort: the account is disconnected locally either way (audit 3.5).
      const revoked = await revokeToken(this.oauth.http, refreshToken);
      this.logger.info(
        { event: 'gmail.token_revoked', accountId: id, revoked },
        'Google grant revoked on disconnect',
      );
    }
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
    const settings = await this.settingsOf(row, true).catch((error: unknown) => {
      throw error instanceof OAuthError && error.kind === 'invalid_grant'
        ? new InboxAuthError('Microsoft sign-in expired')
        : error;
    });
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
    this.tokens.delete(id);
    this.db
      .prepare(
        `UPDATE channel_accounts SET status = 'auth_required', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(this.now().toISOString(), id);
    this.logger.warn({ event: 'account.auth_required', accountId: id }, 'email account needs a new password');
  }

  /**
   * Runs the transaction that stores references to freshly written secrets; if it fails, the
   * secrets are deleted (outside it: a delete inside would roll back too) instead of lingering.
   */
  private orDropSecrets<T>(ids: (string | null)[], fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      for (const id of ids) if (id) this.secrets.delete(id);
      throw error;
    }
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
        const fresh = await refreshAccessToken(this.oauth.http, { clientId, clientSecret, refreshToken });
        this.tokens.set(row.id, { token: fresh.accessToken, expiresAt: fresh.expiresAt });
        return fresh.accessToken;
      } catch (error) {
        if (error instanceof OAuthError && error.kind === 'invalid_grant') this.markAuthRequired(row.id);
        throw error;
      }
    };
    return new GmailApi(this.oauth.http, token);
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
    const base = { address: row.external_account_id, username: m.username, smtp: m.smtp, imap: m.imap };
    if (m.oauth) {
      return {
        ...base,
        password: '',
        ...(withPassword ? { accessToken: await this.microsoftToken(row.id) } : {}),
      };
    }
    let password = '';
    if (withPassword) {
      if (!row.secret_id) throw new RpcError('CONFLICT', 'Account has no password', 'account.noPassword');
      password = await this.secrets.reveal(row.secret_id);
    }
    return { ...base, password };
  }

  /** A valid Microsoft access token for the account, renewed from the refresh token when due. */
  private microsoftToken(id: string): Promise<string> {
    const cached = this.tokens.get(id);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > Date.now()) return Promise.resolve(cached.token);
    const pending = this.refreshing.get(id);
    if (pending) return pending;
    const work = this.refreshMicrosoft(id).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, work);
    return work;
  }

  private async refreshMicrosoft(id: string): Promise<string> {
    // The stored refresh token may have been replaced since a channel was built: read it now.
    const row = this.row(id);
    const oauth = (JSON.parse(row.metadata) as Metadata).oauth;
    if (!oauth || !row.secret_id)
      throw new RpcError('CONFLICT', 'Account has no sign-in', 'account.noPassword');
    const refreshToken = await this.secrets.reveal(row.secret_id);
    let fresh;
    try {
      fresh = await microsoftRefresh(this.oauth.http, oauth, refreshToken);
    } catch (error) {
      if (error instanceof OAuthError && error.kind === 'invalid_grant') this.markAuthRequired(id);
      this.logger.warn(
        {
          event: 'microsoft.token_refresh_failed',
          accountId: id,
          kind: error instanceof OAuthError ? error.kind : 'other',
        },
        'could not renew the Microsoft token',
      );
      throw error;
    }
    if (fresh.refreshToken && fresh.refreshToken !== refreshToken) {
      await this.replaceRefreshToken(id, row.secret_id, fresh.refreshToken);
    }
    this.tokens.set(id, { token: fresh.accessToken, expiresAt: fresh.expiresAt });
    return fresh.accessToken;
  }

  /**
   * Microsoft hands out a new refresh token with each renewal; the new one is kept and the old one
   * deleted. If the account changed meanwhile (signed in again, disconnected), the new one is dropped.
   */
  private async replaceRefreshToken(id: string, oldSecretId: string, token: string): Promise<void> {
    const newId = await this.secrets.put('oauth_refresh_token', token);
    const { changes } = this.db
      .prepare(
        `UPDATE channel_accounts SET secret_id = ? WHERE id = ? AND secret_id = ? AND status != 'disabled'`,
      )
      .run(newId, id, oldSecretId);
    this.secrets.delete(Number(changes) > 0 ? oldSecretId : newId);
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
    signIn: r.provider === 'gmail_api' ? 'google' : m.oauth ? 'microsoft' : 'password',
    oauthClient: m.oauth
      ? { clientId: m.oauth.clientId, tenant: m.oauth.tenant }
      : m.clientId
        ? { clientId: m.clientId, tenant: null }
        : null,
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
          // A large message is read only in part: enough to match it, not to fill the memory.
          load: () =>
            box.download(
              'INBOX',
              m.uid,
              m.size <= MAX_WHOLE_MESSAGE_BYTES ? MAX_WHOLE_MESSAGE_BYTES : PARTIAL_MESSAGE_BYTES,
              signal,
            ),
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
        if (error instanceof OAuthError || (error instanceof GmailError && error.isAuth)) {
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
          load: () => api.load(m.messageId, MAX_WHOLE_MESSAGE_BYTES, signal),
          cursor: { a: 0, b: Number(m.historyId) },
        })),
        more,
        ...(since.expired ? { warning: 'historyExpired' as const } : {}),
      };
    },
    close: async () => {},
  };
}
