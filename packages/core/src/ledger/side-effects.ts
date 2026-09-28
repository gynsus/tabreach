import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';
import { transaction } from '../db/database.js';

export type SideEffectStatus = 'reserved' | 'executing' | 'completed' | 'not_sent' | 'unknown';
export type ReconciledBy = 'provider_lookup' | 'ui_verification' | 'user_confirmation';

/** The logical intent: what is done, to whom, for which step (never the content — ADR 018). */
export interface IntentParts {
  /** Enrollment id, or a standalone workflow id. */
  scopeId: string;
  stepPosition: number;
  channel: string;
  actionType: string;
  /** Normalized target identity (email, profile URL, form URL). */
  target: string;
}

export interface SideEffectRow {
  id: string;
  idempotency_key: string;
  scope_id: string;
  step_position: number;
  channel: string;
  action_type: string;
  target_normalized: string;
  workflow_run_id: string | null;
  status: SideEffectStatus;
  content_hash: string | null;
  external_refs: string;
  reconciled_by: ReconciledBy | null;
  error_class: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What the caller must do after reserving:
 * - `execute`: nothing was attempted (or a previous attempt was verified not sent) — go ahead;
 * - `already_done`: completed earlier — do not send again, just continue the workflow;
 * - `reconcile`: an attempt may have reached the recipient — find out, never re-send blindly.
 */
export type Reservation =
  | { action: 'execute'; effect: SideEffectRow }
  | { action: 'already_done'; effect: SideEffectRow }
  | { action: 'reconcile'; effect: SideEffectRow };

export function intentKey(parts: IntentParts): string {
  const raw = ['v1', parts.scopeId, parts.stepPosition, parts.channel, parts.actionType, parts.target].join(
    '|',
  );
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Ledger of external side effects (ADR 018, ADR 021 §3). Re-execution of an intent is allowed only
 * from `not_sent`; `executing` and `unknown` resolve only through reconciliation.
 */
export class SideEffectLedger {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
  ) {}

  /**
   * `guard` runs inside the reserving transaction, only when the result would be `execute`: the
   * final pre-send checks (suppression, caps, approval hash) and the reservation commit together
   * (ADR 021 §6). A guard that throws leaves the ledger unchanged.
   */
  reserve(parts: IntentParts, workflowRunId: string, contentHash: string, guard?: () => void): Reservation {
    return transaction(this.db, () => {
      const key = intentKey(parts);
      const existing = this.byKey(key);
      if (!existing || existing.status === 'reserved' || existing.status === 'not_sent') guard?.();
      if (!existing) {
        const ts = this.now().toISOString();
        this.db
          .prepare(
            `INSERT INTO side_effects (id, idempotency_key, scope_id, step_position, channel, action_type,
                                       target_normalized, workflow_run_id, status, content_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
          )
          .run(
            uuidv7(),
            key,
            parts.scopeId,
            parts.stepPosition,
            parts.channel,
            parts.actionType,
            parts.target,
            workflowRunId,
            contentHash,
            ts,
            ts,
          );
        return { action: 'execute', effect: this.byKey(key) as SideEffectRow };
      }
      switch (existing.status) {
        case 'completed':
          return { action: 'already_done', effect: existing };
        case 'executing':
        case 'unknown':
          return { action: 'reconcile', effect: existing };
        case 'reserved':
        case 'not_sent':
          // Reserved but never marked executing: the irreversible call was not made.
          this.update(existing.id, { status: 'reserved', content_hash: contentHash, error_class: null });
          return { action: 'execute', effect: this.byKey(key) as SideEffectRow };
      }
    });
  }

  /** Must commit BEFORE the irreversible call, so a crash after it is recognizable as "maybe sent". */
  markExecuting(id: string): void {
    this.transition(id, ['reserved'], { status: 'executing' });
  }

  markCompleted(id: string, externalRefs: Record<string, unknown> = {}, reconciledBy?: ReconciledBy): void {
    this.transition(id, ['executing', 'unknown'], {
      status: 'completed',
      external_refs: JSON.stringify(externalRefs),
      reconciled_by: reconciledBy ?? null,
    });
  }

  /** Verified that nothing reached the recipient; the intent may be executed again. */
  markNotSent(id: string, errorClass: string, reconciledBy?: ReconciledBy): void {
    this.transition(id, ['reserved', 'executing', 'unknown'], {
      status: 'not_sent',
      error_class: errorClass,
      reconciled_by: reconciledBy ?? null,
    });
  }

  markUnknown(id: string, errorClass: string): void {
    this.transition(id, ['executing'], { status: 'unknown', error_class: errorClass });
  }

  get(id: string): SideEffectRow | undefined {
    return this.db.prepare('SELECT * FROM side_effects WHERE id = ?').get(id) as SideEffectRow | undefined;
  }

  byKey(key: string): SideEffectRow | undefined {
    return this.db.prepare('SELECT * FROM side_effects WHERE idempotency_key = ?').get(key) as
      SideEffectRow | undefined;
  }

  /** The ledger rows of one enrollment step, whatever their target. */
  forStep(scopeId: string, stepPosition: number): SideEffectRow[] {
    return this.db
      .prepare('SELECT * FROM side_effects WHERE scope_id = ? AND step_position = ?')
      .all(scopeId, stepPosition) as unknown as SideEffectRow[];
  }

  /**
   * Touches toward a target since `since` (ADR 021 §6): executing, completed and unknown count —
   * an uncertain send is treated as sent.
   */
  touchesSince(channelTargets: readonly { channel: string; target: string }[], since: Date): string[] {
    if (channelTargets.length === 0) return [];
    const clauses = channelTargets.map(() => '(channel = ? AND target_normalized = ?)').join(' OR ');
    const params = channelTargets.flatMap((t) => [t.channel, t.target]);
    const rows = this.db
      .prepare(
        `SELECT updated_at FROM side_effects
         WHERE (${clauses}) AND status IN ('executing', 'completed', 'unknown') AND updated_at >= ?
         ORDER BY updated_at`,
      )
      .all(...params, since.toISOString()) as { updated_at: string }[];
    return rows.map((r) => r.updated_at);
  }

  private transition(id: string, from: SideEffectStatus[], fields: Partial<SideEffectRow>): void {
    const row = this.get(id);
    if (!row) throw new Error(`Side effect ${id} not found`);
    if (!from.includes(row.status)) {
      throw new Error(`Side effect ${id}: cannot go from ${row.status} to ${fields.status ?? '?'}`);
    }
    this.update(id, fields);
  }

  private update(id: string, fields: Partial<SideEffectRow>): void {
    const entries = Object.entries(fields);
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    this.db
      .prepare(`UPDATE side_effects SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...entries.map(([, v]) => v as string | number | null), this.now().toISOString(), id);
  }
}
