import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '@tabreach/protocol';
import type { MessageChannel, OutgoingMessage, ReconcileResult, SendResult } from './channel.js';

/**
 * How the next send behaves. `hang_*` never resolves, which is how tests simulate core dying in
 * the middle of a send: before the message left, or after it did.
 */
export type TestOutcome =
  'completed' | 'not_sent' | 'unknown' | 'hang_before_delivery' | 'hang_after_delivery';

/**
 * Test channel (ADR 021 §7): the "outside world" is the `test_channel_deliveries` table. It lets
 * Phase 2 run whole campaigns and crash scenarios without email or a browser.
 */
export class TestChannel implements MessageChannel {
  readonly channel = 'test';
  readonly accountId = null;
  private readonly forced: TestOutcome[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => Date,
    readonly minSpacingMs = 0,
    readonly dailyLimit: number | null = null,
  ) {}

  /** Queues outcomes for the next sends (first in, first used); afterwards sends complete. */
  force(...outcomes: TestOutcome[]): void {
    this.forced.push(...outcomes);
  }

  deliveries(): { idempotency_key: string; target: string; subject: string | null; body: string }[] {
    return this.db
      .prepare(
        'SELECT idempotency_key, target, subject, body FROM test_channel_deliveries ORDER BY created_at, id',
      )
      .all() as { idempotency_key: string; target: string; subject: string | null; body: string }[];
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const outcome = this.forced.shift() ?? 'completed';
    if (outcome === 'not_sent') return { outcome: 'not_sent', errorClass: 'test_rejected' };
    if (outcome === 'hang_before_delivery') return new Promise<never>(() => {});
    const id = uuidv7();
    this.db
      .prepare(
        `INSERT INTO test_channel_deliveries (id, idempotency_key, target, subject, body, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        message.idempotencyKey,
        message.target,
        message.subject,
        message.body,
        message.contentHash,
        this.now().toISOString(),
      );
    if (outcome === 'hang_after_delivery') return new Promise<never>(() => {});
    if (outcome === 'unknown') return { outcome: 'unknown', errorClass: 'test_no_confirmation' };
    return { outcome: 'completed', externalRefs: { deliveryId: id } };
  }

  async reconcile(idempotencyKey: string): Promise<ReconcileResult> {
    const row = this.db
      .prepare('SELECT id FROM test_channel_deliveries WHERE idempotency_key = ?')
      .get(idempotencyKey) as { id: string } | undefined;
    return row ? { status: 'completed', externalRefs: { deliveryId: row.id } } : { status: 'not_sent' };
  }
}
