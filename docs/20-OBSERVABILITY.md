# 20 — Observability

## Goals

Make it possible to answer:

- what is the system doing;
- why did it do it;
- what external action happened;
- which prospect/campaign caused it;
- can the workflow safely retry.

## Structured logs

- pino JSON logs, one stream per process (`main`, `core`, `worker`), written to `~/Library/Logs/TabReach/`; rotated at 10 MB (checked every minute while running and at start), five generations kept.
- Every record supports: timestamp, level, process, correlation ID, workflow ID, task/action ID when relevant, event code, redacted context.
- Every log object passes through the shared `redactDeep` (`packages/protocol/src/redact.ts`), also used for audit payloads: credential keys in any casing or separator style (`access_token`, `X-Api-Key`, `refreshToken`, `Set-Cookie`, …) at any depth, token-looking strings (Bearer, `sk-…`, Google OAuth tokens) inside messages and stacks; past the depth limit values are dropped, not kept. Unit-tested.
- Logs carry no personal data where avoidable: e.g. a failed Chrome check logs the host, not the URL.

Avoid free-form-only logs for important state changes.

## Correlation

A campaign step execution gets a correlation ID propagated through:

```text
core workflow
-> job
-> channel adapter
-> browser protocol message
-> worker task
-> action events
```

## Metrics

No metrics server. Core computes local counters/aggregates from the database and shows them in a simple status view:

- workflows pending/running/waiting/failed;
- jobs pending/dead;
- browser task latency and failure rate;
- `unsupported_state` rate per adapter-pack version (signals that LinkedIn changed its UI);
- semantic resolution rate;
- human intervention count;
- email send success/failure, bounces;
- research latency/cost;
- AI token usage/cost per month and per use case (implemented, Settings → AI); per campaign planned with the per-campaign budget (Phase 8).

## Action timeline

The user-visible audit view is backed by `action_events`, not reconstructed from text logs.

Implementation (2026-09-29): events store ids only (ADR 022), so each event is linked to the contact, company and campaign it concerns when it is read, through the current records — the enrollment, approval, conversation, research run or send it is about (`TimelineService`). The same query serves the contact page (its campaign steps: added, AI draft, approval by the user or the campaign policy, send with the message, reply with its AI label, stop reason), the company page (the company, its research and all its contacts), the campaign page and the Activity view (with category filters and paging). Adding a contact to a campaign records `enrollment.created` per contact.

## Diagnostics bundle

The user can generate a sanitized bundle (zip, saved via a save dialog) containing:

- app, Electron, Chrome and adapter-pack versions;
- recent redacted logs;
- relevant action events;
- selected screenshots (user chooses);
- workflow/job state;
- OS version.

Must exclude:

- the `secrets` table and any decrypted secret;
- OAuth tokens, API keys, passwords;
- cookies;
- browser profile directories.

Nothing is uploaded automatically; the user decides where to send it.

Implementation (Phase 8a, 2026-10-09): Status → Diagnostics bundle. Core (`DiagnosticsService`) builds a zip (`fflate`, pure JavaScript) and the renderer hands it to main's save dialog (`saveTextFile` with `encoding: 'base64'`):

- `manifest.json` — app, Electron, Node, worker, Playwright and Chrome versions, database health, OS, adapter-pack versions, and what is excluded;
- `state.json` — the last 14 days and everything still open: workflow runs, jobs (with their redacted last error), sends (channel, action, status, error class, reconciliation — no target, no content), browser tasks (state, error key, pack version, expected states — no URL, page title or snapshot), requests to the person;
- `events.json` — action events of the last 14 days (ids, codes, redacted payloads; ADR 022);
- `logs/` — the last 2 MB of `main.log`, `core.log` and `worker.log`, every line redacted again on the way out;
- `screenshots/` — only the masked screenshots the person ticks, chosen among those the worker kept for its own tasks, by exact name.

The `secrets` table is never read; nothing comes from browser profile directories. A unit test checks that a stored secret, an API key in a log, a profile URL and a page title never reach the zip, and that no file outside the diagnostics folder can be added.

## Telemetry

None by default. Any future crash/usage reporting must be opt-in and use the same redaction.

## Logging levels

- `error`: failed operation needing attention;
- `warn`: recovered anomaly, challenge, unsupported state;
- `info`: domain state transition;
- `debug`: development diagnostics, off in release builds by default.
