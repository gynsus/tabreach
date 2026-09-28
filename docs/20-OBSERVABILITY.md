# 20 — Observability

## Goals

Make it possible to answer:

- what is the system doing;
- why did it do it;
- what external action happened;
- which prospect/campaign caused it;
- can the workflow safely retry.

## Structured logs

- pino JSON logs, one stream per process (`main`, `core`, `worker`), written to `~/Library/Logs/TabReach/` with rotation and a size cap.
- Every record supports: timestamp, level, process, correlation ID, workflow ID, task/action ID when relevant, event code, redacted context.
- A redaction layer (pino `redact` paths + value scrubbers for tokens/keys/cookies/emails in debug dumps) is mandatory and unit-tested.

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
