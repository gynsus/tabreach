# 05 — Database Schema

This document specifies the initial relational shape. Migrations are authoritative once implementation begins.

## General rules

- SQLite 3 (via `better-sqlite3`), one file, opened only by core.
- Pragmas on open: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- Tables declared `STRICT` where the ORM allows it.
- Primary keys: `id TEXT` holding a UUIDv7 string generated in application code.
- Timestamps: `TEXT` in ISO-8601 UTC with milliseconds and `Z` (`2026-09-28T10:00:00.000Z`) — lexicographically sortable.
- Booleans: `INTEGER` 0/1 with `CHECK`.
- Enumerations: `TEXT` with `CHECK (col IN (...))`.
- JSON: `TEXT` validated with `CHECK (json_valid(col))`; only for extensible metadata/configuration, not as a replacement for core relational fields.
- Soft-delete only where recovery/audit value justifies it.
- Append-only audit events (enforced in code; optionally with a trigger rejecting `UPDATE`/`DELETE`).
- Unique constraints for idempotency and provider IDs.
- `lock_version INTEGER` on mutable workflow rows (optimistic concurrency within core).

Column lists below omit types where they follow the rules above.

## Tables

### `companies`

```text
id pk
name not null
domain null
domain_normalized null
website_url null
country, region, city null
timezone null
status not null
custom_fields json not null default '{}'
created_at, updated_at not null
```

Index on `domain_normalized`. A unique partial index may be introduced only after duplicate-merge behaviour is defined.

### `contacts`

```text
id pk
company_id fk -> companies
first_name, last_name, full_name
job_title
email
email_normalized
email_status check in ('unknown','valid','bounced','invalid')
timezone null
status not null
custom_fields json not null default '{}'
created_at, updated_at
```

Index `email_normalized`.

### `contact_profile_urls`

```text
id pk
contact_id fk
channel                  -- e.g. 'linkedin'
url_original
url_normalized
```

Unique `(channel, url_normalized)`.

### `contact_channel_eligibility`

```text
contact_id fk
channel
eligibility check in ('allowed','not_allowed','unknown')
source
updated_at
```

Primary key `(contact_id, channel)`.

### `tags`, `company_tags`, `contact_tags`

Normal many-to-many tag schema.

### `suppressions`

```text
id pk
kind check in ('email','domain','company','profile_url')
value_normalized not null
reason check in ('opt_out','bounce','manual','imported')
source_ref json null
created_at
```

Unique `(kind, value_normalized)`.

### `research_runs`

```text
id pk
target_type, target_id
status
config_snapshot json
summary
qualification check in ('match','possible_match','not_match','insufficient_data') null
qualification_reason
model_provider, model_name
prompt_template_key, prompt_template_version
usage json                -- tokens, cost estimate
started_at, completed_at
error_code, error_message_redacted
```

### `evidence`

```text
id pk
research_run_id fk
target_type, target_id
source_url
source_title
evidence_type
captured_text
structured_payload json
extractor
content_hash
captured_at
```

Index by `(target_type, target_id)` and `research_run_id`.

### `research_facts`

```text
id pk
research_run_id fk
kind check in ('fact','inference')
claim
evidence_ids json         -- array of evidence ids
quotes json               -- array of {evidenceId, quote, verified}
confidence real null
```

### `campaigns`

```text
id pk
name
status
draft_config json         -- mutable editing state
active_version_id null fk -> campaign_versions
created_at, updated_at
```

### `campaign_versions`

```text
id pk
campaign_id fk
version_number integer
config json               -- immutable non-step settings (goal, ICP, instructions, approval, limits, windows, timezone)
created_at
```

Unique `(campaign_id, version_number)`. Steps are **not** duplicated inside `config`; they live only in `sequence_steps`.

### `sequence_steps`

```text
id pk
campaign_version_id fk
position integer
step_type
execution_mode check in ('auto','assisted','manual')
delay_seconds integer
config json
created_at
```

Unique `(campaign_version_id, position)`.

### `campaign_enrollments`

```text
id pk
campaign_version_id fk
company_id null fk
contact_id null fk
status
current_step_position
next_action_at null
stop_reason null
last_reply_at null
created_at, updated_at
lock_version integer
```

Check: company or contact present. Index `(status, next_action_at)`.

### `workflow_runs`

```text
id pk
workflow_type
definition_version integer
business_type, business_id
status
current_state
context json
correlation_id
retry_count integer
next_attempt_at null
lock_version integer
created_at, updated_at
```

### `workflow_step_runs`

```text
id pk
workflow_run_id fk
state
attempt integer
status
input_hash
result json
started_at, completed_at
error_code, error_message_redacted
```

Unique `(workflow_run_id, state, attempt)`.

### `browser_tasks`

```text
id pk
workflow_run_id fk
task_type
browser_profile_id fk
browser_session_id null fk
adapter_pack_id, adapter_pack_version null
status check in ('dispatched','running','checkpointed','succeeded','failed','unknown','interrupted')
checkpoint json null
result json null
dispatched_at, finished_at
```

### `message_drafts`

```text
id pk
contact_id fk
campaign_enrollment_id null fk
channel
subject
body
fact_ids json
generation_meta json
content_hash
version integer
created_at
```

### `draft_checks`

```text
id pk
message_draft_id fk
content_hash              -- checks are bound to the exact version
check_key                 -- 'grounding','length','forbidden_phrases','links','signature', ...
passed integer
details json
created_at
```

### `approvals`

```text
id pk
object_type, object_id
campaign_enrollment_id null
target_snapshot json
content_hash
scope check in ('single_action','campaign')
decision check in ('approved','rejected','skipped')
actor
expires_at null
created_at
```

### `side_effects`

```text
id pk
idempotency_key unique not null
workflow_run_id fk
channel
action_type
status check in ('reserved','executing','completed','failed','unknown')
content_hash null
external_refs json        -- {messageId, providerMessageId, threadId, url, ...}
reconciled_by null check in ('provider_lookup','ui_verification','user_confirmation')
error_class null
created_at, updated_at
```

Replaces the earlier generic `idempotency_keys` table. See ADR 018.

### `browser_profiles`

```text
id pk
name
purpose check in ('channel_identity','research','general')
channel_account_id null
status
locale null
timezone null
browser_channel           -- 'chrome' (default); 'chromium' for tests
last_opened_at
last_health_check_at
health json
created_at, updated_at
```

The directory is derived from the profile ID (`profiles/{id}`); no path is stored.

### `browser_sessions`

```text
id pk
browser_profile_id fk
worker_instance_id
control_mode check in ('automation','paused','human')
status
current_url
started_at, ended_at
heartbeat_at
```

### `human_interventions`

```text
id pk
workflow_run_id fk
browser_session_id null fk
reason
status
instructions
resolution json           -- incl. user-confirmed outcome
resolution_notes
requested_at, resolved_at
```

### `channel_accounts`

```text
id pk
channel                   -- 'email' | 'linkedin'
provider                  -- 'gmail_api' | 'imap_smtp' | 'linkedin_browser'
display_name
external_account_id
browser_profile_id null
secret_id null fk -> secrets
limits json
status
metadata json             -- non-secret config: IMAP host, OAuth client id, ...
created_at, updated_at
```

### `secrets`

```text
id pk
purpose                   -- 'ai_api_key' | 'oauth_refresh_token' | 'oauth_client_secret' | 'imap_password' ...
ciphertext blob           -- produced by Electron safeStorage in main
created_at, updated_at
```

Ciphertext is only decryptable on this Mac user account. Core never logs this table. Local recovery backups contain it as ciphertext (needed so a rollback keeps credentials); portable exports exclude it (see backup kinds in `03-SYSTEM-ARCHITECTURE.md`).

### `conversations`

```text
id pk
channel
channel_account_id fk
contact_id fk
campaign_enrollment_id null
provider_thread_id null
status
created_at, updated_at
```

Unique `(channel_account_id, provider_thread_id)` when provider thread ID exists.

### `messages`

```text
id pk
conversation_id fk
direction check in ('inbound','outbound')
rfc_message_id null
provider_message_id null
in_reply_to null
subject
body null                 -- subject to retention
classification null
metadata json
occurred_at
created_at
```

Unique `(conversation_id, provider_message_id)`; index `rfc_message_id`.

### `action_events`

```text
id pk
correlation_id
causation_id null
actor_type
action_type
object_type null
object_id null
status
adapter_pack_version null
payload_redacted json
created_at
```

Index `(correlation_id, created_at)` and `(object_type, object_id, created_at)`.

### `jobs`

```text
id pk
type
payload json
schema_version integer
status check in ('pending','running','succeeded','failed','dead')
run_at                    -- earliest execution time
attempts integer
max_attempts integer
lease_owner null
lease_until null
last_error_class null
last_error_redacted null
dedupe_key null unique    -- optional, for jobs that must exist once
correlation_id
created_at, updated_at
```

Index `(status, run_at)`. Dead jobs are shown in the UI's "needs attention" view.

### `settings`

Key/value (`key text pk`, `value json`) for application settings, including contact-policy settings and adapter kill switches.

## Migration discipline

- Never edit an applied migration.
- Before applying migrations, core creates a local recovery backup in `data/backups/` using the SQLite online backup API or `VACUUM INTO` — never a plain file copy of a WAL database.
- Every migration must have a safe rollback strategy (restore from pre-migration backup is acceptable for the local app) or be documented as irreversible.
- Destructive schema changes require an explicit data migration plan.
- Migration tests run against an empty DB and against a DB produced by the previous release's migrations.
