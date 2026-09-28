# 04 — Domain Model

## Aggregate overview

The application is single-user; there is no workspace/tenant entity.

```text
Company
 +-- Contact
 +-- Evidence
 +-- ResearchRun
      +-- ResearchFact

SuppressionEntry
ContactPolicySettings (singleton settings)

Campaign
 +-- CampaignVersion
      +-- SequenceStep

CampaignEnrollment
 +-- WorkflowRun
      +-- WorkflowStepRun
      +-- BrowserTask

MessageDraft
 +-- DraftCheckResult
Approval
SideEffect            (ledger of external actions)
BrowserProfile
BrowserSession
HumanIntervention
ChannelAccount
Conversation
 +-- Message
ActionEvent           (append-only audit)
Job                   (durable queue entry)
```

## Company

Fields:

- id (UUIDv7);
- name;
- normalized domain;
- website URL;
- country/region/city optional;
- timezone optional (used for quiet hours);
- status;
- tags;
- custom fields (JSON);
- created/updated timestamps.

## Contact

Fields:

- id;
- company ID;
- first/last/full name;
- title;
- email;
- normalized email;
- email status (`unknown`, `valid`, `bounced`, `invalid`);
- known profile URLs (normalized + original);
- channel eligibility (per channel: allowed / not allowed / unknown);
- timezone optional;
- status;
- custom fields;
- timestamps.

## SuppressionEntry

Do-not-contact rule.

Fields:

- kind: `email | domain | company | profile_url`;
- normalized value;
- reason: `opt_out | bounce | manual | imported`;
- source reference (message ID, import ID, user);
- created timestamp.

Suppression is checked immediately before every critical action (final pre-send check), not only at enrollment.

## ContactPolicySettings

Global settings:

- frequency caps: max touches per contact per N days; max touches per company per N days;
- company-level stop on reply (default on);
- default quiet hours;
- whether to keep the Mac awake while campaigns are active.

## Evidence

An immutable captured source.

Fields:

- id;
- company/contact ID;
- source URL;
- source title;
- evidence type;
- captured text (normalized);
- structured payload JSON;
- capture timestamp;
- extractor;
- content hash;
- research run ID.

Do not rewrite evidence to match later AI conclusions.

## ResearchRun

One research attempt/version.

Fields:

- id;
- target type/id;
- status;
- input configuration snapshot;
- started/completed;
- AI model and prompt template version;
- summary;
- qualification result;
- qualification explanation;
- token usage/cost;
- error.

## ResearchFact

A claim extracted during a research run.

Fields:

- research run ID;
- kind: `fact | inference`;
- claim text;
- evidence ID(s);
- verbatim quote(s) — for `fact`, each quote must be found in the referenced evidence's captured text (normalized whitespace/case) or the fact is rejected;
- confidence optional.

## Campaign

Mutable campaign draft (the editable configuration).

Launching creates an immutable `CampaignVersion`; enrollments always point to a version.

## CampaignVersion

Immutable snapshot:

- name;
- goal;
- ICP configuration;
- research and message instructions;
- sequence (as `SequenceStep` rows);
- sender/channel account assignments;
- approval policy and, for `approve_campaign`, the reviewed sample and check configuration;
- stop conditions;
- limits, active windows and timezone.

## SequenceStep

- position;
- step type;
- execution mode `auto | assisted | manual`;
- delay;
- condition (for `condition` steps);
- step config.

## CampaignEnrollment

One contact (or company, for form steps) enrolled in one campaign version.

Fields:

- campaign version ID;
- contact/company;
- state;
- current step position;
- next action at;
- stop reason;
- last reply at.

## WorkflowRun

One executable state machine that performs one step for one enrollment (or a standalone task such as a research run).

Fields:

- workflow type and definition version;
- business target;
- generic status and domain-specific current state;
- serialized context;
- lock version;
- retry count;
- next attempt at.

## BrowserTask

The durable record, owned by core, of a unit of browser work dispatched to the worker.

Fields:

- workflow run ID;
- task type;
- browser profile/session;
- adapter pack ID and version;
- status: `dispatched | running | checkpointed | succeeded | failed | unknown | interrupted`;
- last checkpoint (reported by worker);
- result (structured);
- timestamps.

## MessageDraft

Fields:

- target;
- channel;
- subject optional;
- body;
- research fact IDs used for personalisation;
- generation metadata (model, template version, token usage);
- content hash;
- version.

## DraftCheckResult

Automated checks run for each draft version: grounding, length, forbidden phrases, links/recipients, signature. Each with pass/fail and details. Required for `approve_campaign` auto-approval.

## Approval

Fields:

- object type/id;
- target identity snapshot;
- content hash;
- scope `single_action | campaign`;
- decision;
- actor;
- timestamp;
- optional expiry.

## SideEffect

The ledger of external actions. One row per **logical intent** (see ADR 018).

Fields:

- idempotency key — derived from enrollment, step position, channel and target identity (never from content);
- channel and action type;
- status: `reserved | executing | completed | failed | unknown`;
- content hash actually sent;
- external references (e.g. app-generated `Message-ID`, provider message/thread IDs, verified URL);
- reconciliation source when resolved from `unknown` (`provider_lookup | ui_verification | user_confirmation`);
- timestamps.

A second attempt for the same key is allowed only when the previous status is `failed` with a retryable error class and verification confirmed nothing was sent.

## BrowserProfile

See `08-BROWSER-PROFILES.md`.

## BrowserSession

One period during which the worker owns a running profile.

Fields:

- browser profile;
- worker instance ID;
- control mode: `automation | paused | human`;
- lifecycle state;
- started/ended;
- current URL;
- heartbeat.

## HumanIntervention

Fields:

- workflow run;
- browser session;
- reason;
- instructions;
- status;
- requested/resolved timestamps;
- resolution (including user-confirmed outcome where applicable);
- resolution notes.

## ChannelAccount

Provider/channel identity: Gmail API account, IMAP/SMTP mailbox, LinkedIn identity bound to a browser profile.

Fields include provider, display name, external account ID, linked browser profile, secret reference, limits, status.

Secrets are never stored inline; a secret reference points to an encrypted secret row.

## Conversation

Normalized conversation thread across a channel.

Fields:

- channel;
- channel account;
- provider thread key;
- contact;
- campaign enrollment optional;
- status.

## Message

Inbound/outbound normalized message.

Fields:

- conversation ID;
- direction;
- provider ID and RFC `Message-ID`;
- subject;
- body (subject to retention);
- sent/received timestamp;
- classification;
- metadata.

## ActionEvent

Append-only audit event.

Fields:

- id;
- correlation ID;
- causation ID;
- actor type;
- action type;
- object references;
- status;
- adapter pack version where applicable;
- redacted payload;
- created timestamp.

## Job

Durable queue entry processed by core (ADR 011). Not a domain aggregate, but part of the persistent model; see `13-WORKFLOW-ENGINE.md`.

## Identity rules

Use UUIDv7 for all entities (sortable, generated in application code).

Provider IDs remain separate fields; never use external IDs as primary keys.
