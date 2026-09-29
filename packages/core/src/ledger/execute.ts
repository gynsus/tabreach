import type { MessageChannel, OutgoingMessage } from '../channels/channel.js';
import { transaction } from '../db/database.js';
import { PermanentError } from '../jobs/dispatcher.js';
import { intentKey, type IntentParts, type SideEffectLedger } from './side-effects.js';

export type ExecutionOutcome =
  | { outcome: 'completed'; sideEffectId: string; alreadyDone: boolean }
  | { outcome: 'not_sent'; sideEffectId: string; errorClass: string; permanent: boolean }
  | { outcome: 'unknown'; sideEffectId: string; errorClass: string }
  /** Reconciliation cannot tell yet; come back at `retryAt` (not a failure). */
  | { outcome: 'pending'; sideEffectId: string; retryAt: Date };

/**
 * The one place that turns "send this" into a ledger-guarded external action (CLAUDE.md §3.5,
 * ADR 018/021):
 *
 * 1. reserve the logical intent;
 * 2. if an earlier attempt may have gone out, reconcile with the channel instead of sending;
 * 3. mark `executing` (committed) BEFORE the irreversible call — for a browser channel, at the
 *    worker's `about_to_commit` checkpoint (docs/07), so the page work before it stays retryable;
 * 4. send, then record completed / not_sent / unknown.
 *
 * A crash after step 3 leaves `executing`; the next run lands in step 2 and never sends twice.
 */
export async function executeSideEffect(opts: {
  ledger: SideEffectLedger;
  channel: MessageChannel;
  intent: IntentParts;
  workflowRunId: string;
  message: Omit<OutgoingMessage, 'idempotencyKey'>;
  signal: AbortSignal;
  /** Final pre-send checks, run in the reserving transaction; throw to block the send. */
  guard?: () => void;
  /**
   * The same checks again at a browser channel's commit point (audit 6.5): opening the site and
   * filling the form take a while, and a stop, a reply or an edit may arrive meanwhile. Throwing
   * refuses the checkpoint — nothing is pressed.
   */
  recheck?: () => void;
  /** Told when reconciliation settled an earlier attempt, for the audit trail. */
  onReconciled?: (outcome: 'completed' | 'not_sent') => void;
  /** Told why a send threw (the outcome is `unknown` either way), for the logs. */
  onSendError?: (error: unknown) => void;
}): Promise<ExecutionOutcome> {
  const { ledger, channel, signal } = opts;
  const key = intentKey(opts.intent);
  const reserve = () =>
    ledger.reserve(opts.intent, opts.workflowRunId, opts.message.contentHash, opts.guard, channel.accountId);
  let reservation = reserve();

  if (reservation.action === 'already_done') {
    return { outcome: 'completed', sideEffectId: reservation.effect.id, alreadyDone: true };
  }

  if (reservation.action === 'reconcile') {
    const id = reservation.effect.id;
    const found = await channel.reconcile(key, signal, new Date(reservation.effect.updated_at));
    if (found.status === 'completed') {
      settle(() => ledger.markCompleted(id, found.externalRefs ?? {}, 'provider_lookup'));
      opts.onReconciled?.('completed');
      return { outcome: 'completed', sideEffectId: id, alreadyDone: true };
    }
    if (found.status === 'pending') {
      return { outcome: 'pending', sideEffectId: id, retryAt: found.retryAt };
    }
    if (found.status === 'unknown') {
      if (reservation.effect.status === 'executing')
        settle(() => ledger.markUnknown(id, 'reconcile_inconclusive'));
      return { outcome: 'unknown', sideEffectId: id, errorClass: 'reconcile_inconclusive' };
    }
    // Verified: the earlier attempt never reached the recipient. It is safe to send now.
    settle(() => ledger.markNotSent(id, 'reconciled_absent', 'provider_lookup'));
    opts.onReconciled?.('not_sent');
    reservation = reserve();
    if (reservation.action !== 'execute') {
      throw new PermanentError(
        'ledger_conflict',
        `Unexpected ledger state after reconciliation: ${reservation.action}`,
      );
    }
  }

  const id = reservation.effect.id;
  const atCheckpoint = channel.commitsAtCheckpoint === true;
  if (!atCheckpoint) ledger.markExecuting(id);
  // Still `reserved`: the channel never reached its commit point, so nothing went out.
  const neverCommitted = () => ledger.get(id)?.status === 'reserved';
  let result;
  try {
    result = await channel.send(
      { ...opts.message, idempotencyKey: key },
      signal,
      atCheckpoint
        ? {
            beforeCommit: () =>
              transaction(ledger.db, () => {
                opts.recheck?.();
                ledger.markExecuting(id);
              }),
          }
        : undefined,
    );
  } catch (error) {
    opts.onSendError?.(error);
    if (neverCommitted()) {
      settle(() => ledger.markNotSent(id, 'failed_before_commit'));
      return { outcome: 'not_sent', sideEffectId: id, errorClass: 'failed_before_commit', permanent: false };
    }
    // We cannot tell whether it left; treat as possibly sent.
    settle(() => ledger.markUnknown(id, 'send_threw'));
    return { outcome: 'unknown', sideEffectId: id, errorClass: 'send_threw' };
  }
  if (result.outcome === 'unknown' && neverCommitted()) {
    result = { outcome: 'not_sent', errorClass: 'not_committed' } as const;
  }
  switch (result.outcome) {
    case 'completed':
      settle(() => ledger.markCompleted(id, result.externalRefs));
      return { outcome: 'completed', sideEffectId: id, alreadyDone: false };
    case 'not_sent':
      settle(() => ledger.markNotSent(id, result.errorClass));
      return {
        outcome: 'not_sent',
        sideEffectId: id,
        errorClass: result.errorClass,
        permanent: result.permanent ?? false,
      };
    case 'unknown':
      settle(() => ledger.markUnknown(id, result.errorClass));
      return { outcome: 'unknown', sideEffectId: id, errorClass: result.errorClass };
  }
}

/**
 * Records what happened after the channel acted. If the ledger row changed meanwhile (a person
 * settled it, say), the job must not retry: a retry could send again. It fails permanently and
 * the uncertain row shows up for a person (audit 3.5).
 */
function settle(mark: () => void): void {
  try {
    mark();
  } catch (error) {
    throw new PermanentError('ledger_conflict', error instanceof Error ? error.message : String(error));
  }
}
