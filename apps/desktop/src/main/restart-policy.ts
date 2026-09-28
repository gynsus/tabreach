export interface RestartDecision {
  restart: boolean;
  delayMs: number;
  recentCrashes: number;
}

/**
 * Bounded exponential backoff for supervised processes: 1 s, 2 s, 4 s ... capped, and a hard stop
 * after too many crashes inside the window (docs/03-SYSTEM-ARCHITECTURE.md, "Process supervision").
 */
export class RestartPolicy {
  private crashes: number[] = [];

  constructor(
    private readonly opts = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxCrashes: 5, windowMs: 120_000 },
  ) {}

  onCrash(now: number = Date.now()): RestartDecision {
    this.crashes = [...this.crashes.filter((t) => now - t < this.opts.windowMs), now];
    const recentCrashes = this.crashes.length;
    if (recentCrashes > this.opts.maxCrashes) {
      return { restart: false, delayMs: 0, recentCrashes };
    }
    const delayMs = Math.min(this.opts.baseDelayMs * 2 ** (recentCrashes - 1), this.opts.maxDelayMs);
    return { restart: true, delayMs, recentCrashes };
  }

  reset(): void {
    this.crashes = [];
  }
}
