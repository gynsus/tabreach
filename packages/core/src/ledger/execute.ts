import type { MessageChannel, OutgoingMessage } from '../channels/channel.js';
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
 * 3. mark `executing` (committed) BEFORE the irreversible call;
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
      ledger.markCompleted(id, found.externalRefs ?? {}, 'provider_lookup');
      return { outcome: 'completed', sideEffectId: id, alreadyDone: true };
    }
    if (found.status === 'pending') {
      return { outcome: 'pending', sideEffectId: id, retryAt: found.retryAt };
    }
    if (found.status === 'unknown') {
      if (reservation.effect.status === 'executing') ledger.markUnknown(id, 'reconcile_inconclusive');
      return { outcome: 'unknown', sideEffectId: id, errorClass: 'reconcile_inconclusive' };
    }
    // Verified: the earlier attempt never reached the recipient. It is safe to send now.
    ledger.markNotSent(id, 'reconciled_absent', 'provider_lookup');
    reservation = reserve();
    if (reservation.action !== 'execute') {
      throw new Error(`Unexpected ledger state after reconciliation: ${reservation.action}`);
    }
  }

  const id = reservation.effect.id;
  ledger.markExecuting(id);
  let result;
  try {
    result = await channel.send({ ...opts.message, idempotencyKey: key }, signal);
  } catch {
    // We cannot tell whether it left; treat as possibly sent.
    ledger.markUnknown(id, 'send_threw');
    return { outcome: 'unknown', sideEffectId: id, errorClass: 'send_threw' };
  }
  switch (result.outcome) {
    case 'completed':
      ledger.markCompleted(id, result.externalRefs);
      return { outcome: 'completed', sideEffectId: id, alreadyDone: false };
    case 'not_sent':
      ledger.markNotSent(id, result.errorClass);
      return {
        outcome: 'not_sent',
        sideEffectId: id,
        errorClass: result.errorClass,
        permanent: result.permanent ?? false,
      };
    case 'unknown':
      ledger.markUnknown(id, result.errorClass);
      return { outcome: 'unknown', sideEffectId: id, errorClass: result.errorClass };
  }
}
