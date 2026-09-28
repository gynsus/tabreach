import type { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_EMAIL_LIMITS,
  RpcError,
  uuidv7,
  type AccountLimits,
  type AccountStatus,
  type ConnectionCheck,
  type EmailAccount,
  type ImapAccountInput,
  type Logger,
  type MailServer,
} from '@tabreach/protocol';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import { normalizeEmail } from '../prospects/normalize.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SecretStore } from '../secrets/secrets.js';
import { EmailChannel } from './email-channel.js';
import type { MailClients, MailSettings } from './transport.js';

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
}

const CHECK_TIMEOUT_MS = 30_000;

/** Providers whose servers keep a copy of mail sent over SMTP; others need an IMAP APPEND. */
const SAVES_SENT = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com|hotmail\.com|live\.com)$/i;

export function serverSavesSent(smtpHost: string): boolean {
  return SAVES_SENT.test(smtpHost.trim());
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
  private readonly channels = new Map<string, { updatedAt: string; channel: EmailChannel }>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly audit: AuditLog,
    private readonly secrets: SecretStore,
    private readonly clients: MailClients,
    private readonly now: () => Date,
    private readonly logger: Logger,
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
      return this.get(id);
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
      return this.get(current.id);
    });
  }

  async test(id: string): Promise<ConnectionCheck> {
    return this.check(await this.settingsOf(this.row(id), true));
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
      this.channels.delete(id);
      this.record('account.disconnected', id, ctx);
    });
  }

  /** The sending channel of an active account, or undefined (unknown, disconnected, needs a new password). */
  channel(accountId: string | null | undefined): EmailChannel | undefined {
    if (!accountId) return undefined;
    const row = this.db.prepare('SELECT * FROM channel_accounts WHERE id = ?').get(accountId) as
      AccountRow | undefined;
    if (!row || row.status !== 'active' || row.provider !== 'imap_smtp') return undefined;
    const cached = this.channels.get(row.id);
    if (cached?.updatedAt === row.updated_at) return cached.channel;
    const dto = toDto(row);
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

  /** The server refused the stored password: stop using the account until the user fixes it. */
  markAuthRequired(id: string): void {
    this.db
      .prepare(
        `UPDATE channel_accounts SET status = 'auth_required', updated_at = ? WHERE id = ? AND status = 'active'`,
      )
      .run(this.now().toISOString(), id);
    this.logger.warn({ event: 'account.auth_required', accountId: id }, 'email account needs a new password');
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
