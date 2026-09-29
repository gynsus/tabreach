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
- AI token usage/cost per day and per campaign.

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

## Telemetry

None by default. Any future crash/usage reporting must be opt-in and use the same redaction.

## Logging levels

- `error`: failed operation needing attention;
- `warn`: recovered anomaly, challenge, unsupported state;
- `info`: domain state transition;
- `debug`: development diagnostics, off in release builds by default.
