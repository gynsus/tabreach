import { redactDeep, scrubString, uuidv7, type Logger } from '@tabreach/protocol';
import type { z } from 'zod';
import type { JobQueue, JobRow } from './queue.js';

/** Try again later (network blip, provider 5xx, spacing not yet reached with a known time). */
export class RetryableError extends Error {
  override name = 'RetryableError';
  constructor(
    readonly errorClass: string,
    message: string = errorClass,
    /** Explicit time to retry at, instead of exponential backoff. */
    readonly retryAt?: Date,
  ) {
    super(message);
  }
}

/** Retrying cannot help (invalid input, policy block). */
export class PermanentError extends Error {
  override name = 'PermanentError';
  constructor(
    readonly errorClass: string,
    message: string = errorClass,
  ) {
    super(message);
  }
}

export interface JobContext {
  jobId: string;
  attempt: number;
  correlationId: string;
  /** Aborted when core stops; long handlers should stop at a safe point. */
  signal: AbortSignal;
}

/**
 * What a handler may return: nothing (done), or a time to run again. Continuing is not a failure —
 * a message waiting for its send window, say — so it neither counts an attempt nor logs an error.
 */
export type JobOutcome = void | { continueAt: Date };

export interface JobType<P> {
  type: string;
  payload: z.ZodType<P>;
  /**
   * Whether the job may cause an effect outside TabReach. Such handlers must go through the
   * side-effect ledger, so that running them again after a crash reconciles instead of repeating.
   */
  sideEffecting: boolean;
  concurrency?: number;
  maxAttempts?: number;
  /** Older than this (since creation) and still failing: dead instead of retrying. */
  maxAgeMs?: number;
  handler(payload: P, ctx: JobContext): Promise<JobOutcome> | JobOutcome;
}

export interface DispatcherOptions {
  queue: JobQueue;
  now: () => Date;
  logger: Logger;
  /** Unique per core process start. */
  owner?: string;
  leaseMs?: number;
  /** Longest sleep between checks even when nothing is due (guards against clock jumps). */
  maxIdleMs?: number;
  onFinished?: (job: JobRow, status: 'succeeded' | 'continued' | 'failed' | 'dead' | 'retry') => void;
}

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempt - 1, 0), MAX_BACKOFF_MS);
  return Math.round(exp * (0.8 + random() * 0.4)); // ±20% jitter
}

/**
 * Runs due jobs (docs/13-WORKFLOW-ENGINE.md). One dispatcher per core; per-type concurrency;
 * wakes on enqueue and on the earliest `run_at` instead of polling each enrollment.
 */
export class Dispatcher {
  readonly owner: string;
  private readonly types = new Map<string, JobType<unknown>>();
  private readonly running = new Map<string, number>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private paused = false;
  private ticking = false;
  private readonly leaseMs: number;
  private readonly maxIdleMs: number;

  constructor(private readonly options: DispatcherOptions) {
    this.owner = options.owner ?? uuidv7();
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxIdleMs = options.maxIdleMs ?? 30_000;
  }

  register<P>(type: JobType<P>): this {
    this.types.set(type.type, type as unknown as JobType<unknown>);
    return this;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const released = this.options.queue.releaseOtherOwners(this.owner);
    if (released > 0) {
      this.options.logger.warn(
        { event: 'jobs.recovered', count: released },
        'recovered jobs of a previous run',
      );
    }
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Mac going to sleep: stop claiming; running jobs finish. */
  pause(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  resume(): void {
    this.paused = false;
    this.schedule(0);
  }

  /** Something was enqueued: look again soon (after the enqueuing transaction commits). */
  wake(): void {
    if (this.started && !this.paused) this.schedule(0);
  }

  /** Runs everything that is due now, including jobs those jobs enqueue for now. For tests and self-check. */
  async runDue(): Promise<void> {
    for (;;) {
      const claimed = this.claimBatch();
      if (claimed.length === 0 && this.inFlight.size === 0) return;
      await Promise.all([...this.inFlight]);
    }
  }

  private schedule(delayMs: number): void {
    if (!this.started || this.paused) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, delayMs));
  }

  private async tick(): Promise<void> {
    if (this.ticking || !this.started || this.paused) return;
    this.ticking = true;
    try {
      this.options.queue.recoverExpired();
      this.claimBatch();
    } catch (error) {
      this.options.logger.error({ event: 'jobs.tick_failed', err: error }, 'dispatcher tick failed');
    } finally {
      this.ticking = false;
    }
    const next = this.options.queue.nextRunAt();
    const wait = next ? next.getTime() - this.options.now().getTime() : this.maxIdleMs;
    this.schedule(Math.min(Math.max(wait, 0), this.maxIdleMs));
  }

  private claimBatch(): JobRow[] {
    const limits = new Map<string, number>();
    for (const [name, type] of this.types) {
      limits.set(name, Math.max((type.concurrency ?? 1) - (this.running.get(name) ?? 0), 0));
    }
    const claimed = this.options.queue.claim(this.owner, this.leaseMs, limits, 16);
    for (const job of claimed) {
      const promise = this.execute(job).finally(() => {
        this.inFlight.delete(promise);
        this.running.set(job.type, (this.running.get(job.type) ?? 1) - 1);
        this.schedule(0);
      });
      this.running.set(job.type, (this.running.get(job.type) ?? 0) + 1);
      this.inFlight.add(promise);
    }
    return claimed;
  }

  private async execute(job: JobRow): Promise<void> {
    const { queue, logger } = this.options;
    const log = logger.child({ jobId: job.id, jobType: job.type, correlationId: job.correlation_id });
    const type = this.types.get(job.type);
    if (!type) {
      queue.fail(job.id, 'unknown_job_type', `No handler for ${job.type}`);
      log.error({ event: 'jobs.unknown_type' }, 'job type not registered');
      this.options.onFinished?.(job, 'failed');
      return;
    }
    const payload = type.payload.safeParse(JSON.parse(job.payload));
    if (!payload.success) {
      queue.fail(job.id, 'invalid_payload', 'Payload failed validation');
      log.error({ event: 'jobs.invalid_payload' }, 'job payload failed validation');
      this.options.onFinished?.(job, 'failed');
      return;
    }
    const renew = setInterval(
      () => queue.renew(job.id, this.owner, this.leaseMs),
      Math.floor(this.leaseMs / 3),
    );
    // Renewing a lease is no reason to keep the process alive.
    renew.unref();
    try {
      const outcome = await type.handler(payload.data, {
        jobId: job.id,
        attempt: job.attempts,
        correlationId: job.correlation_id,
        signal: this.abort.signal,
      });
      if (outcome) {
        // Never sooner than a second from now: a handler bug must not become a hot loop.
        const floor = this.options.now().getTime() + 1_000;
        queue.reschedule(job.id, new Date(Math.max(outcome.continueAt.getTime(), floor)));
        this.options.onFinished?.(job, 'continued');
        return;
      }
      queue.succeed(job.id);
      this.options.onFinished?.(job, 'succeeded');
    } catch (error) {
      this.handleFailure(job, type, error, log);
    } finally {
      clearInterval(renew);
    }
  }

  private handleFailure(job: JobRow, type: JobType<unknown>, error: unknown, log: Logger): void {
    const { queue, now } = this.options;
    const message = scrubString(error instanceof Error ? error.message : String(error));
    if (error instanceof PermanentError) {
      queue.fail(job.id, error.errorClass, message);
      log.warn({ event: 'jobs.failed', errorClass: error.errorClass }, 'job failed permanently');
      this.options.onFinished?.(job, 'failed');
      return;
    }
    const errorClass = error instanceof RetryableError ? error.errorClass : 'unexpected';
    const tooOld = now().getTime() - new Date(job.created_at).getTime() > (type.maxAgeMs ?? 24 * 60 * 60_000);
    const exhausted = job.attempts >= Math.min(job.max_attempts, type.maxAttempts ?? job.max_attempts);
    if (exhausted || tooOld) {
      queue.bury(job.id, errorClass, message);
      log.error(
        { event: 'jobs.dead', errorClass, attempts: job.attempts, err: redactDeep(error) },
        'job is dead',
      );
      this.options.onFinished?.(job, 'dead');
      return;
    }
    const retryAt =
      error instanceof RetryableError && error.retryAt
        ? error.retryAt
        : new Date(now().getTime() + backoffMs(job.attempts));
    queue.retryLater(job.id, retryAt, errorClass, message);
    log.warn(
      { event: 'jobs.retry', errorClass, attempt: job.attempts, retryAt: retryAt.toISOString() },
      'job will retry',
    );
    this.options.onFinished?.(job, 'retry');
  }
}
