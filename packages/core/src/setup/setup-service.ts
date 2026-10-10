import type { DatabaseSync } from 'node:sqlite';
import type { ChromeInfo, SetupState } from '@tabreach/protocol';
import { z } from 'zod';
import type { AuditLog } from '../audit/audit-log.js';
import { transaction } from '../db/database.js';
import type { CommandContext } from '../prospects/prospect-service.js';
import type { SettingsRepository } from '../settings/settings.js';

const KEY = 'setup.completedAt';

/**
 * First-run setup (FR-APP-002, docs/01): Chrome, the AI key, an email account and a first browser
 * profile. Reads what is already configured; the steps themselves use the ordinary settings
 * commands. Finishing or skipping is remembered so the wizard opens by itself only once.
 */
export class SetupService {
  constructor(
    private readonly d: {
      db: DatabaseSync;
      settings: SettingsRepository;
      audit: AuditLog;
      now: () => Date;
      aiKeySet: () => boolean;
      /** Chrome as the worker sees it; null when the worker does not answer. */
      chrome: () => Promise<ChromeInfo | null>;
    },
  ) {}

  async state(): Promise<SetupState> {
    const count = (sql: string) => (this.d.db.prepare(sql).get() as { n: number }).n;
    return {
      chrome: await this.d.chrome(),
      aiKeySet: this.d.aiKeySet(),
      emailAccounts: count(
        `SELECT COUNT(*) AS n FROM channel_accounts WHERE channel = 'email' AND status != 'disabled'`,
      ),
      profiles: count(`SELECT COUNT(*) AS n FROM browser_profiles WHERE status != 'archived'`),
      completedAt: this.d.settings.get(KEY, z.iso.datetime()) ?? null,
    };
  }

  async complete(ctx: CommandContext): Promise<SetupState> {
    if (!this.d.settings.get(KEY, z.iso.datetime())) {
      transaction(this.d.db, () => {
        this.d.settings.set(KEY, this.d.now().toISOString());
        this.d.audit.record({
          actorType: 'user',
          actionType: 'setup.completed',
          objectType: 'settings',
          objectId: KEY,
          correlationId: ctx.correlationId,
        });
      });
    }
    return this.state();
  }
}
