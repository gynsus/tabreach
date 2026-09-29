# 05 — Database Schema

This document specifies the initial relational shape. Migrations are authoritative once implementation begins.

## General rules

- SQLite 3 via Node's built-in `node:sqlite` (ADR 011), one file, opened only by core.
- Pragmas on open: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`.
- Tables declared `STRICT`.
- Primary keys: `id TEXT` holding a UUIDv7 string generated in application code.
- Timestamps: `TEXT` in ISO-8601 UTC with milliseconds and `Z` (`2026-09-28T10:00:00.000Z`) — lexicographically sortable.
- Booleans: `INTEGER` 0/1 with `CHECK`.
- Enumerations: `TEXT` with `CHECK (col IN (...))`.
- JSON: `TEXT` validated with `CHECK (json_valid(col))`; only for extensible metadata/configuration, not as a replacement for core relational fields.
- Soft-delete only where recovery/audit value justifies it.
- Append-only audit events (enforced in code; optionally with a trigger rejecting `UPDATE`/`DELETE`).
- Unique constraints for idempotency and provider IDs.
- **Unicode-aware keys.** SQLite's `lower()`, `LIKE` and `COLLATE NOCASE` fold ASCII only, so Cyrillic names would neither match nor be found case-insensitively. Tables that are matched or searched by text store TypeScript-computed keys: `name_key` (for dedupe and sorting) and `search_key` (lowercased, whitespace-collapsed text for `LIKE`). Keys are maintained by the repositories on every insert/update.
- `lock_version INTEGER` on mutable workflow rows (optimistic concurrency within core).

Column lists below omit types where they follow the rules above.

## Tables

### `companies`

```text
id pk
name not null
name_key not null             -- nameKey(name), Unicode lowercase
search_key not null           -- name + domain
domain_normalized null        -- punycode, no www; UNIQUE when not null
website_url null
country, city null
timezone null             -- IANA zone; sending hours for its contacts (editable, CSV `company_timezone`, audit 4.5)
status not null
custom_fields json not null default '{}'
created_at, updated_at not null
```

Unique partial index on `domain_normalized` (the company dedupe key, FR-PROS-005); index on `name_key`.

### `contacts`

```text
id pk
company_id fk -> companies
first_name, last_name, full_name
job_title
email
email_normalized          -- lowercase, IDN domain in punycode; UNIQUE when not null
name_key null             -- key of full name or first + last
search_key not null
email_status check in ('unknown','valid','bounced','invalid')
timezone null             -- IANA zone; overrides the company's for sending hours (CSV `timezone`)
reply_hold_released_at null  -- the user allowed campaigns to write again after a reply (migration 11)
status not null
custom_fields json not null default '{}'
created_at, updated_at
```

Unique partial index on `email_normalized` (the contact dedupe key); index on `(company_id, name_key)`.

### `contact_profile_urls`

```text
id pk
contact_id fk
channel                  -- e.g. 'linkedin'
url_original
url_normalized
```

Unique `(channel, url_normalized)`.

### `contact_channel_eligibility` (planned, Phase 6 — not created yet)

```text
contact_id fk
channel
eligibility check in ('allowed','not_allowed','unknown')
source
updated_at
```

Primary key `(contact_id, channel)`.

### `tags`, `company_tags`, `contact_tags`

`tags (id, name, name_key UNIQUE)`; link tables `(entity_id, tag_id)` primary key, `WITHOUT ROWID`. Tags match case-insensitively through `name_key`.

### `suppressions`

```text
id pk
kind check in ('email','domain','company','profile_url')
value_original not null   -- for display: as entered; domains in Unicode form; company: its name
value_normalized not null -- email/domain (punycode) normalized; profile_url as `<channel>:<normalized>`; company: company id
reason check in ('opt_out','bounce','manual','imported')
source_ref json null
search_key not null       -- Unicode-lowercased original + normalized (migration 6)
created_at
```

Unique `(kind, value_normalized)`. Domain entries match the domain and its subdomains at send time (ADR 021 §6).

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
status check in ('draft','active','paused','archived')
draft_config json         -- mutable editing state
active_version_id null fk -> campaign_versions
lock_version integer      -- optimistic concurrency for status changes
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
campaign_id fk            -- denormalized for "one enrollment per contact per campaign"
campaign_version_id fk
company_id null fk
contact_id null fk
status check in ('active','paused','completed','stopped')
current_step_position
next_action_at null       -- owns the gap between steps (ADR 021 §1)
stop_reason null
last_reply_at null
created_at, updated_at
lock_version integer
```

Check: company or contact present. Unique `(campaign_id, contact_id)`. Index `(status, next_action_at)`.

### `workflow_runs`

```text
id pk
workflow_type
definition_version integer
business_type, business_id
step_position null        -- for enrollment steps: which step this run executes
status check in ('pending','running','waiting_approval','waiting_for_human','waiting_external',
                 'paused','completed','failed','cancelled')
current_state
context json
correlation_id
lock_version integer
created_at, updated_at
```

No retry fields: execution retries belong to `jobs` (ADR 021 §2). Waiting between steps belongs to the enrollment; waiting inside a step is a status here.

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
contact_id null fk        -- null for company-level drafts (web forms); CHECK contact or company present
company_id null fk
campaign_enrollment_id null fk
workflow_run_id null fk   -- the run the draft belongs to; unique (workflow_run_id, version)
channel
subject
body
fact_ids json
generation_meta json
content_hash
version integer
origin                    -- 'template' | 'ai' | 'user' (migration 14)
created_at
```

### `draft_checks`

```text
message_draft_id fk       -- a draft version never changes, so checks are bound to exactly it
check_key                 -- 'grounding','length','forbidden_phrases','links','signature','target'
passed integer
detail text null          -- what failed, e.g. the unsupported specifics
created_at
primary key (message_draft_id, check_key)
```

### `approvals`

```text
id pk
workflow_run_id fk
campaign_enrollment_id null
message_draft_id null fk
draft_version integer null
target_snapshot json
content_hash
scope check in ('single_action','campaign')
status check in ('pending','approved','rejected','skipped','superseded','expired')
decided_by null           -- 'user' | 'campaign_policy'
decided_at null
expires_at null
created_at
```

A row is created `pending` when a workflow reaches `CHECK_APPROVAL`; a draft edit marks open rows `superseded` and creates a new `pending` one (ADR 021 §4).

### `side_effects`

```text
id pk
idempotency_key unique not null   -- sha256 of v1|scope id|step|channel|action|normalized target (ADR 021 §3)
scope_id, step_position, channel, action_type, target_normalized   -- readable key parts
workflow_run_id null fk           -- run that first reserved the key; ON DELETE SET NULL
status check in ('reserved','executing','completed','not_sent','unknown')
content_hash null
external_refs json        -- {messageId, providerMessageId, threadId, url, ...}
reconciled_by null check in ('provider_lookup','ui_verification','user_confirmation')
error_class null          -- why it was not sent
created_at, updated_at
```

Re-execution of an intent is allowed only from `not_sent`. See ADR 018 and ADR 021 §3.

### `command_log`

```text
idempotency_key pk        -- caller-chosen UUID (envelope idempotencyKey)
command_type
result json               -- the first result, returned again for repeated keys
created_at                -- pruned after 7 days
```

Exactly-once execution of creating commands from the UI (ADR 020). Not used for external side effects.

### `browser_profiles` (migration 15)

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

### `browser_sessions` (migration 15; `status` opening | open | closed | interrupted, `ended_at`)

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
limits json               -- { dailyLimit, minSpacingSeconds }
status check in ('active','auth_required','disabled')
metadata json             -- non-secret config: SMTP/IMAP servers, username, sender name, appendToSent, OAuth client id
created_at, updated_at
```

Unique `(channel, provider, external_account_id)` among accounts that are not disabled. `side_effects.channel_account_id` (nullable, migration 9) records the account that sent; pacing is per account.

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
contact_id null fk          -- null for a possible reply matched only by company domain
company_id null fk
campaign_enrollment_id null
provider_thread_id null
status check in ('open','archived')
unread 0/1
last_message_at
created_at, updated_at
```

Check contact or company present. Unique `(channel_account_id, contact_id)`; unique `(channel_account_id, company_id)` where contact is null.

### `messages`

```text
id pk
conversation_id fk
direction check in ('inbound','outbound')
rfc_message_id null
provider_message_id null    -- IMAP: '<uidvalidity>:<uid>'
in_reply_to null
from_address null
subject
body null                   -- plain text, at most 20 000 characters; subject to retention
classification null check in ('reply','out_of_office','auto','bounce')
match_strength null check in ('thread','contact_address','domain_only')
review_status check in ('none','pending','confirmed','dismissed')
metadata json
occurred_at
created_at
```

Unique `(conversation_id, provider_message_id)`; index `rfc_message_id`. Only prospect mail is stored (ADR 024).

### Research (implemented, migration 13)

`research_runs (id, company_id, status, error, criteria, summary, qualification, qualification_reason, reason_to_contact, missing_information json, template, model, pages_fetched, pages_skipped, correlation_id, started_at, finished_at)`; `evidence (id, url, title, content_hash unique, text, extractor, captured_at)`; `research_run_evidence (research_run_id, evidence_id)`; `research_facts (id, research_run_id, position, kind fact|inference, claim, evidence_id, quote, verified 0/1, based_on json, created_at)`. The earlier `research_runs` / `evidence` / `research_facts` sections above describe the target shape; these are what exists.

### `ai_calls`

`(id pk, use_case, provider, model, template_key, template_version, status check in ('ok','invalid_output','error','refused'), input_tokens, output_tokens, cost_usd null, latency_ms, error_class, correlation_id, created_at)` — usage and cost per call, no prompts or content. `messages` also has `ai_label`, `ai_confidence`, `ai_template` (migration 12).

### `mailbox_cursors`

`(channel_account_id pk, folder, uid_validity, last_uid, last_polled_at, last_error)` — where polling left off.

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

Append-only is enforced by `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort. Retention of audit events therefore needs an explicit, audited maintenance path; until one is designed, audit events are kept (see `18-SECURITY-PRIVACY-COMPLIANCE.md`).

Payloads hold identifiers, field names, counts, enums and codes only — never names, emails, domains, URLs or message text (ADR 022), so erasing a person never requires touching this table. `action_type` and `object_type` come from the catalogue in `packages/protocol/src/audit.ts`.

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

Jobs own execution retries: `failed` = non-retryable error class, `dead` = retries or maximum age exhausted. Leases last 60 s and are renewed every 20 s by long handlers; `lease_owner` is the core process instance id. Each job type declares whether it is side-effecting; expired side-effecting jobs go to reconciliation, never straight back to `pending` (ADR 021 §2).

### `test_channel_deliveries` (Phase 2)

```text
id pk
idempotency_key
target
subject null
body
content_hash
created_at
```

Forced outcomes for recovery tests (`completed`, `not_sent`, `unknown`, hangs) are queued in memory by the test channel, not stored.

### `settings`

Key/value (`key text pk`, `value json`, `updated_at`) for application settings: UI language, contact policy, AI settings and references to encrypted AI keys (`ai.key.<provider>`), later adapter kill switches.

## Migration discipline

- Never edit an applied migration.
- A migration may add a TypeScript data step (`run`) for work SQL cannot do (Unicode keys); it runs in the same transaction. Table rebuilds set `foreignKeysOff`, and the runner checks `PRAGMA foreign_key_check` before commit.
- Before applying migrations, core creates a local recovery backup in `data/backups/` using the SQLite online backup API or `VACUUM INTO` — never a plain file copy of a WAL database.
- Every migration must have a safe rollback strategy (restore from pre-migration backup is acceptable for the local app) or be documented as irreversible.
- Destructive schema changes require an explicit data migration plan.
- Migration tests run against an empty DB and against a DB produced by the previous release's migrations.
