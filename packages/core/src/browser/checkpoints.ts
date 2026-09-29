import type { DatabaseSync } from 'node:sqlite';
import type { Logger, TaskCheckpoint } from '@tabreach/protocol';

/**
 * Core's side of the `about_to_commit` checkpoint (docs/07 "Checkpoint rule", ADR 018). A browser
 * channel registers what to record before its task starts; when the worker reaches the point of
 * no return it asks here, and presses only after "executing" is committed. A checkpoint nobody
 * expects (an old task, a restarted core) or one that cannot be recorded is refused: no press.
 */
export class BrowserCheckpoints {
  private readonly waiting = new Map<string, () => void>();
  private readonly reachedTasks = new Set<string>();

  constructor(
    private readonly d: {
      db: DatabaseSync;
      now: () => Date;
      logger: Logger;
      /** App-wide pause: a task in flight stops at its checkpoint (docs/19). */
      paused?: () => boolean;
    },
  ) {}

  expect(taskId: string, beforeCommit: () => void): void {
    this.waiting.set(taskId, beforeCommit);
  }

  /** Whether the worker got past the checkpoint: after it, the action may have happened. */
  reached(taskId: string): boolean {
    return this.reachedTasks.has(taskId);
  }

  forget(taskId: string): void {
    this.waiting.delete(taskId);
    this.reachedTasks.delete(taskId);
  }

  reach(req: TaskCheckpoint): { proceed: boolean } {
    const record = this.waiting.get(req.taskId);
    if (!record) {
      this.d.logger.warn({ event: 'task.checkpoint_unexpected', taskId: req.taskId }, 'refused');
      return { proceed: false };
    }
    this.waiting.delete(req.taskId); // one press per task
    if (this.d.paused?.()) return { proceed: false };
    try {
      record();
    } catch (error) {
      // The ledger row changed (a person decided, say): the action must not happen.
      this.d.logger.warn({ event: 'task.checkpoint_refused', taskId: req.taskId, err: error }, 'refused');
      return { proceed: false };
    }
    this.reachedTasks.add(req.taskId);
    this.d.db
      .prepare('UPDATE browser_tasks SET checkpoint = ? WHERE id = ?')
      .run(JSON.stringify({ phase: req.phase, at: this.d.now().toISOString() }), req.taskId);
    return { proceed: true };
  }
}
