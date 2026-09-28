# 02 — Functional Requirements

Requirement IDs are stable and should be referenced by tests and implementation tasks. Requirements added in the 2026-09-28 revision are marked *(new)*.

## Prospect management

- **FR-PROS-001** User can create a company.
- **FR-PROS-002** User can create a contact linked to a company.
- **FR-PROS-003** User can import prospects from CSV with a mapping preview.
- **FR-PROS-004** Import reports inserted, updated, skipped and invalid rows.
- **FR-PROS-005** System detects likely duplicates by normalized domain, email and channel profile URL.
- **FR-PROS-006** User can add tags and arbitrary string/number/boolean/date custom fields.
- **FR-PROS-007** User can export prospects and campaign status to CSV.

## Contact policy *(new)*

- **FR-POL-001** User can add suppression entries by email, domain, company or profile URL, manually or by CSV.
- **FR-POL-002** A suppressed target is never contacted; the check runs immediately before every critical action.
- **FR-POL-003** Frequency caps limit touches per contact and per company across all campaigns within a configurable window.
- **FR-POL-004** A reply from a contact of a company can stop sequences for the whole company (configurable, default on) — only for strong matches (provider thread/`References`, or exact known contact address) or after user confirmation. Domain-only matches never stop a company automatically.
- **FR-POL-005** A reply classified as opt-out adds a suppression entry and stops all sequences for that contact.
- **FR-POL-006** Policy decisions are recorded as action events with the rule that blocked the action.

## Research

- **FR-RES-001** User can request research for one prospect or campaign batch.
- **FR-RES-002** Research is bounded by configured page/time/token limits.
- **FR-RES-003** Every material fact contains at least one evidence record and a verbatim quote verified to exist in the captured text.
- **FR-RES-004** Research output separates observed facts from AI interpretation.
- **FR-RES-005** User can inspect evidence URL, captured text and the highlighted quote.
- **FR-RES-006** Re-running research creates a new research version rather than silently overwriting provenance.
- **FR-RES-007** Research failure does not destroy previous valid research.
- **FR-RES-008** *(new)* Browser-rendered research uses a dedicated research profile, never a channel identity profile (e.g. LinkedIn).

## Campaigns

- **FR-CAM-001** User can create, edit, archive and clone campaigns.
- **FR-CAM-002** Campaign contains a sequence of ordered steps.
- **FR-CAM-003** Campaign supports per-step delays.
- **FR-CAM-004** Campaign supports simple conditions based on prospect/research/execution fields.
- **FR-CAM-005** Campaign can be paused globally.
- **FR-CAM-006** Individual prospect execution can be paused/stopped.
- **FR-CAM-007** Reply can stop remaining steps.
- **FR-CAM-008** User can preview the complete first planned action before launching.
- **FR-CAM-009** Campaign launch snapshots relevant configuration to avoid retroactive mutation of running executions.
- **FR-CAM-010** *(new)* Each step has an execution mode (`auto`, `assisted`, `manual`) limited to the modes the adapter supports.
- **FR-CAM-011** *(new)* Quiet hours are evaluated in the recipient's timezone when known, otherwise in the campaign timezone.
- **FR-CAM-012** *(new)* After Mac sleep or app downtime, missed actions are rescheduled into the next permitted window without bursting.

## Messaging

- **FR-MSG-001** AI can generate a subject and body from campaign instructions plus evidence.
- **FR-MSG-002** Generated message stores model, prompt template version and evidence/fact IDs.
- **FR-MSG-003** User can edit the draft.
- **FR-MSG-004** Approval binds to exact content hash and target.
- **FR-MSG-005** Changing recipient or content invalidates approval.
- **FR-MSG-006** *(new)* Drafts are checked automatically (grounding of personalised claims, length bounds, forbidden phrases, no new URLs or recipients, required signature). Check results are shown in the approval view.

## Approvals *(new section; previously part of Human approval)*

- **FR-APR-001** Default critical-action policy is `approve_each`.
- **FR-APR-002** User can approve, edit, skip or reject.
- **FR-APR-003** User can configure `approve_campaign`, which requires approving the campaign version and reviewing a sample of at least N drafts (configurable, default 5).
- **FR-APR-004** Under `approve_campaign`, a draft that fails any automated check falls back to per-item approval.
- **FR-APR-005** Pending approvals are reviewable in a batch queue with keyboard navigation.

## Browser profiles

- **FR-BRP-001** User can create a managed browser profile.
- **FR-BRP-002** Profile uses an isolated user-data directory.
- **FR-BRP-003** User can open profile manually and sign in.
- **FR-BRP-004** Runtime can start/stop the profile while preserving authenticated state.
- **FR-BRP-005** Only one runtime owner can control a profile at a time.
- **FR-BRP-006** Profile can be marked unhealthy and require manual intervention.
- **FR-BRP-007** User can delete a profile only after explicit destructive confirmation.
- **FR-BRP-008** *(new)* App detects whether Google Chrome is installed and reports its version; without it, browser features are disabled with a clear explanation.

## Browser actions

- **FR-BRA-001** Runtime can navigate, click, type, scroll and extract.
- **FR-BRA-002** Every action has a unique ID and correlation ID.
- **FR-BRA-003** Critical actions are idempotency guarded by the side-effect ledger.
- **FR-BRA-004** Runtime verifies navigation/action result where possible.
- **FR-BRA-005** Deterministic locator is attempted before semantic resolution.
- **FR-BRA-006** Semantic resolution records the candidate set, the chosen candidate, the model and the rationale.
- **FR-BRA-007** Browser failure creates diagnostics without secrets where feasible.
- **FR-BRA-008** Runtime can stop immediately on user request.
- **FR-BRA-009** *(new)* Adapters act only when the current page positively matches an expected state; otherwise the result is `UNSUPPORTED_STATE`.
- **FR-BRA-010** *(new)* In `auto` mode, the final target of a critical action cannot be chosen by semantic resolution.

## Human control and takeover

- **FR-HUM-001** CAPTCHA/2FA/security challenge produces `WAITING_FOR_HUMAN`.
- **FR-HUM-002** User can take manual control of the browser from the desktop app.
- **FR-HUM-003** Automation cannot act while manual control is held.
- **FR-HUM-004** Before resume, runtime re-validates current page and target state.
- **FR-HUM-005** *(new)* When the system cannot determine whether an action happened during manual control or in `assisted`/`manual` mode, it asks the user to confirm the outcome; the answer is recorded as the reconciliation source.
- **FR-HUM-006** *(new)* The in-page overlay can only pause automation; resuming, returning control and approving are available only in the desktop app.

## Email

- **FR-EML-001** User can connect a Gmail account through their own Google OAuth client using a guided wizard (including a Google Workspace Internal path).
- **FR-EML-002** User can connect any mailbox via IMAP/SMTP.
- **FR-EML-003** System can send an approved message.
- **FR-EML-004** Every outbound message has an app-generated `Message-ID` persisted before sending.
- **FR-EML-005** Provider message/thread IDs are persisted.
- **FR-EML-006** Replies are ingested and linked to the correct prospect/campaign when possible, with a match strength (`thread`, `contact_address`, `domain_only`). Auto-replies, bulk mail and role addresses are not treated as replies.
- **FR-EML-007** Reply classification is stored separately from raw reply.
- **FR-EML-008** Bounces are detected, mark the address invalid and stop the sequence.
- **FR-EML-009** System never logs OAuth tokens or passwords.
- **FR-EML-010** After an interrupted send, the system reconciles by searching the Sent mailbox for the `Message-ID` (with delayed retries for search indexing). If the outcome stays uncertain, the send remains `unknown`, is surfaced to the user, and is never re-sent automatically.

## Website forms

- **FR-FRM-001** Adapter can locate a likely contact page/form.
- **FR-FRM-002** Adapter can map common form fields.
- **FR-FRM-003** System shows the final field payload before critical submission under `approve_each`.
- **FR-FRM-004** CAPTCHA blocks submission and requests human control.
- **FR-FRM-005** Submission result is verified or marked `unknown`, never assumed successful.
- **FR-FRM-006** Consent/marketing checkboxes are never ticked without an explicit configured meaning.

## LinkedIn *(new section)*

- **FR-LIN-001** Adapter can be disabled globally (kill switch, fails closed).
- **FR-LIN-002** Default execution mode is `assisted`; `auto` requires explicit opt-in per action class.
- **FR-LIN-003** Target identity (profile URL + name) is verified before any critical action.
- **FR-LIN-004** Before every follow-up message the adapter opens the conversation and checks for new inbound messages; if found, the step stops and a reply event is recorded.
- **FR-LIN-005** Application safety throttles per account (product defaults, not LinkedIn-published limits) are conservative; campaigns may lower them; raising them requires an explicit settings change with a risk warning.
- **FR-LIN-006** Page-state recognizers and locators come from a versioned adapter pack; the pack version is recorded on every action event.

## Audit

- **FR-AUD-001** Every external side effect has planned/started/completed/failed/unknown events.
- **FR-AUD-002** User can inspect a chronological timeline.
- **FR-AUD-003** Events record actor: `user`, `system`, `ai`, `browser_worker`, `channel_adapter`.
- **FR-AUD-004** Sensitive fields are redacted.

## Application *(new section)*

- **FR-APP-001** App runs as a single signed macOS application without external service prerequisites except Google Chrome.
- **FR-APP-002** First-run wizard configures AI key, email account and first browser profile.
- **FR-APP-003** App handles Mac sleep/wake: pauses scheduling on suspend, re-evaluates schedule on resume.
- **FR-APP-004** User can optionally keep the Mac awake while campaigns are active.
- **FR-APP-005** User can create a local recovery backup (full DB, secrets only as ciphertext) and a portable export (without secrets) and restore from a local recovery backup.
