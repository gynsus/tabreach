import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';

export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  run_at: string;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  last_error_class: string | null;
  last_error_redacted: string | null;
  dedupe_key: string | null;
  correlation_id: string;
  created_at: string;
  updated_at: string;
}

export interface EnqueueOptions {
  runAt?: Date;
  /** At most one active (pending/running) job per key; freed when the job finishes. */
  dedupeKey?: string;
  maxAttempts?: number;
  correlationId?: string;
}

const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Durable job queue in SQLite (ADR 011, ADR 021 §2). `enqueue` joins the caller's transaction, so a
 * job exists exactly when the state change that needs it committed — no outbox, no dual write.
 * All times come from the injected clock.
 */
export class JobQueue {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
    /** Told after every enqueue so the dispatcher can wake up instead of polling. */
    private readonly onEnqueued: () => void = () => {},
  ) {}

  /** Returns the job id, or null when an active job with the same dedupe key already exists. */
  enqueue(type: string, payload: unknown, opts: EnqueueOptions = {}): string | null {
    const ts = this.now().toISOString();
    const id = uuidv7();
    const result = this.db
      .prepare(
        `INSERT INTO jobs (id, type, payload, status, run_at, attempts, max_attempts, dedupe_key, correlation_id,
                           created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .run(
        id,
        type,
        JSON.stringify(payload),
        (opts.runAt ?? this.now()).toISOString(),
        opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        opts.dedupeKey ?? null,
        opts.correlationId ?? uuidv7(),
        ts,
        ts,
      );
    if (Number(result.changes) === 0) return null;
    this.onEnqueued();
    return id;
  }

  /**
   * Claims due jobs for `owner` (the core instance) under a lease. `limits` caps how many of each
   * type may be claimed now (per-type concurrency minus what is already running).
   */
  claim(owner: string, leaseMs: number, limits: ReadonlyMap<string, number>, max: number): JobRow[] {
    const now = this.now();
    const due = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT ?`)
      .all(now.toISOString(), max * 4) as unknown as JobRow[];
    const taken = new Map<string, number>();
    const claimed: JobRow[] = [];
    const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
    const update = this.db.prepare(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    );
    for (const job of due) {
      if (claimed.length >= max) break;
      const limit = limits.get(job.type) ?? 1;
      const used = taken.get(job.type) ?? 0;
      if (used >= limit) continue;
      if (Number(update.run(owner, leaseUntil, now.toISOString(), job.id).changes) === 1) {
        taken.set(job.type, used + 1);
        claimed.push({
          ...job,
          status: 'running',
          attempts: job.attempts + 1,
          lease_owner: owner,
          lease_until: leaseUntil,
        });
      }
    }
    return claimed;
  }

  renew(id: string, owner: string, leaseMs: number): void {
    const until = new Date(this.now().getTime() + leaseMs).toISOString();
    this.db
      .prepare(
        `UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`,
      )
      .run(until, this.now().toISOString(), id, owner);
  }

  succeed(id: string): void {
    this.finish(id, 'succeeded', null, null);
  }

  /** Non-retryable failure: the workflow decides what it means. */
  fail(id: string, errorClass: string, message: string): void {
    this.finish(id, 'failed', errorClass, message);
  }

  /** Retries exhausted or too old: shown under "Needs attention". */
  bury(id: string, errorClass: string, message: string): void {
    this.finish(id, 'dead', errorClass, message);
  }

  retryLater(id: string, runAt: Date, errorClass: string, message: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', run_at = ?, lease_owner = NULL, lease_until = NULL,
                         last_error_class = ?, last_error_redacted = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(runAt.toISOString(), errorClass, message.slice(0, 500), this.now().toISOString(), id);
  }

  /** The handler asked to run again later: not a failure, so the attempt is given back. */
  reschedule(id: string, runAt: Date): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', run_at = ?, attempts = MAX(attempts - 1, 0), lease_owner = NULL,
                         lease_until = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(runAt.toISOString(), this.now().toISOString(), id);
  }

  /** The newest job of a type whose payload field has this value (active or finished). */
  latestFor(type: string, payloadField: string, value: string): JobRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM jobs WHERE type = ? AND json_extract(payload, ?) = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(type, `$.${payloadField}`, value) as JobRow | undefined;
  }

  /** The job holding a dedupe key right now (pending or running), if any. */
  byDedupeKey(key: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE dedupe_key = ?').get(key) as JobRow | undefined;
  }

  /**
   * After a crash: running jobs whose lease expired go back to pending. Side-effecting handlers are
   * guarded by the side-effect ledger, so running them again leads to reconciliation, not a repeat.
   */
  recoverExpired(): JobRow[] {
    const now = this.now().toISOString();
    const expired = this.db
      .prepare(`SELECT * FROM jobs WHERE status = 'running' AND lease_until < ?`)
      .all(now) as unknown as JobRow[];
    this.db
      .prepare(
        `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
         WHERE status = 'running' AND lease_until < ?`,
      )
      .run(now, now);
    return expired;
  }

  /** Jobs of a previous core instance (after a restart) are expired regardless of their lease. */
  releaseOtherOwners(owner: string): number {
    const now = this.now().toISOString();
    return Number(
      this.db
        .prepare(
          `UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ?
           WHERE status = 'running' AND lease_owner IS NOT ?`,
        )
        .run(now, owner).changes,
    );
  }

  nextRunAt(): Date | null {
    const row = this.db.prepare(`SELECT MIN(run_at) AS at FROM jobs WHERE status = 'pending'`).get() as
      { at: string | null } | undefined;
    return row?.at ? new Date(row.at) : null;
  }

  get(id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  needsAttention(limit = 200): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status IN ('dead', 'failed') ORDER BY updated_at DESC LIMIT ?`)
      .all(limit) as unknown as JobRow[];
  }

  /** Puts a dead or failed job back in the queue with a fresh attempt budget. */
  requeue(id: string): boolean {
    const ts = this.now().toISOString();
    return (
      Number(
        this.db
          .prepare(
            `UPDATE jobs SET status = 'pending', attempts = 0, run_at = ?, last_error_class = NULL,
                             last_error_redacted = NULL, updated_at = ?
             WHERE id = ? AND status IN ('dead', 'failed')`,
          )
          .run(ts, ts, id).changes,
      ) === 1
    );
  }

  dismiss(id: string): boolean {
    return (
      Number(
        this.db.prepare(`DELETE FROM jobs WHERE id = ? AND status IN ('dead', 'failed')`).run(id).changes,
      ) === 1
    );
  }

  /** Finished jobs free their dedupe key so the same work can be scheduled again later. */
  private finish(id: string, status: JobStatus, errorClass: string | null, message: string | null): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, dedupe_key = NULL, lease_owner = NULL, lease_until = NULL,
                         last_error_class = COALESCE(?, last_error_class),
                         last_error_redacted = COALESCE(?, last_error_redacted), updated_at = ?
         WHERE id = ?`,
      )
      .run(status, errorClass, message?.slice(0, 500) ?? null, this.now().toISOString(), id);
  }
}
