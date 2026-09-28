import type { DatabaseSync } from 'node:sqlite';
import { RpcError } from '@tabreach/protocol';
import { transaction } from '../db/database.js';

const RETENTION_DAYS = 7;

/**
 * Exactly-once execution of creating commands per idempotency key (ADR 020). The command's writes
 * and the stored result commit together, so a retry after a timeout returns the first result
 * instead of creating a duplicate.
 */
export class CommandLog {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date = () => new Date(),
  ) {}

  once<T>(key: string | undefined, commandType: string, fn: () => T): T {
    if (!key) return fn();
    return transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT command_type, result FROM command_log WHERE idempotency_key = ?')
        .get(key) as { command_type: string; result: string } | undefined;
      if (row) {
        if (row.command_type !== commandType) {
          throw RpcError.validation(
            { idempotencyKey: 'idempotency.reused' },
            'Key was used for another command',
          );
        }
        return JSON.parse(row.result) as T;
      }
      const result = fn();
      this.db
        .prepare(
          'INSERT INTO command_log (idempotency_key, command_type, result, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(key, commandType, JSON.stringify(result), this.now().toISOString());
      return result;
    });
  }

  /** Drops entries older than the retention window; returns how many were removed. */
  prune(): number {
    const cutoff = new Date(this.now().getTime() - RETENTION_DAYS * 86_400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM command_log WHERE created_at < ?').run(cutoff).changes);
  }
}
