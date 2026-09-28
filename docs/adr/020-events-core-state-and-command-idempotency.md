# ADR 020 — Events, core state and command idempotency

**Status:** Accepted (2026-09-28, Phase 1.5 hardening)

## Context

The Phase 1 audit found three gaps in the inter-process design that Phase 2 (approval queues, live workflow status) cannot build on:

1. **No push channel.** Docs promised `subscribe`, but the bridge had only `invoke`, and `RpcPeer` dropped every event as invalid. The UI could not learn that data changed except by re-querying.
2. **The renderer did not know when core was down.** During a restart backoff, and forever after the restart policy gave up, every request waited for its full timeout (30 s; 5 min for imports) and no screen said why. After a restart nothing refetched.
3. **Timeouts lied about outcomes.** A command that timed out in the UI kept running in core and committed; the user retried and got a duplicate. In Phase 2 the same pattern would report "not sent" for a message that was sent.

## Decision

### Events
- `packages/protocol/src/events.ts` holds an **event registry** with a Zod schema per type, parallel to the request registry. `RpcPeer` gains `emit(type, payload)` and `on(type, listener)`; inbound events are validated and delivered, unknown or invalid ones reported via `onInvalid`.
- Events are **hints, never commands**: receivers refetch authoritative state.
- First event: `data.changed { entities: ('company'|'contact'|'suppression'|'activity'|'settings')[] }`, emitted by core to every connected window after each successful mutation.
- The preload keeps renderer subscriptions itself and re-attaches them to every new port, so subscriptions survive core restarts and page reloads. Bridge: `subscribe(type, listener) → unsubscribe`.

### Core state
- main's supervisor reports `starting | running | restarting | failed` for core and sends `tabreach:core-state` to the window (also right after each page load).
- The preload closes the dead port immediately (pending requests fail fast with `UNAVAILABLE`), rejects new requests at once when `failed`, and exposes `onCoreState(listener)`.
- The renderer shows a banner while core is not running and, when core returns, refetches everything (events sent while it was down are lost by design).

### Command idempotency
- The envelope gains an optional `idempotencyKey` (UUID). `HandlerContext` exposes it.
- Core's `command_log` table stores the result of **creating** commands per key: `companies.create`, `contacts.create`, `imports.prospects.commit`, `suppressions.import`. A repeated key returns the stored result without executing again; the command's writes and the stored result commit in one transaction. The same key used for a different command type is rejected. Entries are pruned after 7 days.
- The renderer generates one key per user intent (per opened form, per chosen file) and reuses it on retry.
- Updates and deletes are naturally idempotent and do not use keys. Phase 2 side effects use the side-effect ledger (ADR 018), not this log.

### Related hardening in the same change
- `RpcPeer`: a synchronous `postMessage` failure rejects immediately with `UNAVAILABLE`; handler/reply failures are reported instead of becoming unhandled rejections; no reply is posted after `close()`.
- Core's worker attachment returns a detach bound to that connection, so a late close event from an old worker port cannot disconnect a new worker.
- `transaction()` nests via SAVEPOINTs and rejects async callbacks (needed for "enqueue a job in the same transaction as the state change").

## Alternatives

- Polling from the renderer: simple, but wasteful, laggy, and still blind to core restarts.
- Idempotency by content (dedupe identical payloads): would merge legitimate repeated actions and fail for imports; an explicit key per intent is precise.
- Cancelling handlers on timeout: SQLite work is synchronous and cannot be interrupted safely; recording the outcome by key is the reliable fix.

## Consequences

- Phase 2 can push approval-queue and workflow updates through the same registry.
- A retried create returns the same record; users do not get duplicates after timeouts.
- The UI tells the truth about core availability.
- Offset paging plus live inserts can still shift rows between pages; cursor paging is planned together with the Phase 2 lists that update live.
