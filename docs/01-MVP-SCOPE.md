# 01 — MVP Scope

## Primary user

One operator running the application on macOS.

The MVP is single-user by design, and the product has no plans for multi-user or cloud operation. The data model does not carry workspace/tenant identifiers.

## Included

### Prospects

- company;
- person/contact;
- websites and known profile URLs;
- email addresses;
- tags;
- custom fields;
- lifecycle status;
- CSV import/export;
- manual create/edit;
- deduplication by normalized email/domain/profile URL.

### Contact policy

- suppression (do-not-contact) list by email, domain, company, or profile URL;
- per-contact channel eligibility;
- frequency caps across campaigns (per contact and per company);
- company-level stop when another contact of the company replies (configurable, default on) — only on strong matches (thread or exact known address) or user confirmation, never on domain-only matches;
- opt-out capture from replies;
- all checks are evaluated at send time, not only at enrollment.

### Research

- crawl/fetch a bounded set of public company pages;
- optionally use browser rendering (dedicated research profile) when static fetch is insufficient;
- extract facts with evidence and verified verbatim quotes;
- create a company summary;
- identify a reason-to-contact;
- qualification against configurable ICP criteria;
- preserve source URL and timestamp.

### Campaigns

- campaign definition;
- sender/browser profile selection;
- sequence steps;
- delays;
- conditions;
- approval mode;
- execution mode per step (`auto` / `assisted` / `manual`);
- per-prospect execution;
- pause/resume;
- stop-on-reply (contact- and company-level).

### Sequence step types

MVP step types:

- `research`
- `generate_message`
- `send_email`
- `visit_url`
- `browser_message`
- `browser_connect`
- `submit_contact_form`
- `wait`
- `condition`
- `human_task`

The `webhook` step type is deferred to after the MVP (ADR 030); the campaign status CSV export covers handing data to a CRM meanwhile.

The capabilities of a channel adapter restrict which actions and execution modes are available.

### Execution modes

- `auto` — the system executes the approved action and verifies it;
- `assisted` — the system prepares everything in the visible browser (target opened and verified, content filled, final control highlighted); the user performs the final click; the system verifies;
- `manual` — the system prepares content and opens the target; the user does the rest and confirms the outcome.

Default per channel: email `auto`, website forms `auto`, LinkedIn `assisted`.

### Email

MVP:

- Gmail via Gmail API using an OAuth client created by the user in their own Google Cloud project, or an Internal client in their Google Workspace (guided setup wizard); a publisher-owned verified client is a later stage (ADR 016);
- generic IMAP/SMTP transport (OAuth2/XOAUTH2 where supported, otherwise app password) — covers Gmail as fallback and other providers;
- app-generated `Message-ID` for every outbound email (enables reconciliation after crashes);
- thread identifiers;
- polling-based reply ingestion;
- reply matching by thread headers, then exact contact address; sender-domain matches are only "possible replies" requiring confirmation; auto-replies/bulk/role senders ignored;
- bounce detection;
- reply classification (interested, not interested, out-of-office, opt-out, bounce, other);
- stop sequence on reply;
- create follow-up.

Microsoft Graph adapter can be added after MVP without redesign.

### Browser runtime

- launch the user's installed Google Chrome with app-managed profile directories;
- dedicated persistent profiles;
- profile health/status;
- tabs/pages;
- navigate;
- read/extract;
- click;
- type;
- scroll;
- screenshot;
- adapter packs with positive page-state recognition;
- bounded semantic target resolution;
- in-page overlay injected by the runtime (no extension);
- pause;
- resume;
- human takeover;
- challenge detection;
- session timeline.

### Website contact forms

- discover contact page/form;
- map common fields semantically;
- fill form;
- show exact outgoing data before submission;
- submit only when approval policy allows;
- record result/evidence;
- never auto-solve CAPTCHA.

### LinkedIn adapter

The adapter is isolated from generic campaign logic and can be disabled with a kill switch.

MVP target:

- open known profile URLs;
- extract only the data required by an active workflow;
- visit profile;
- prepare message/connection action;
- `assisted` execution by default; `auto` only by explicit per-action-class opt-in;
- verify target identity before any critical action;
- **check the conversation for new inbound messages before every follow-up** (mandatory precondition);
- detect authentication/security challenges;
- detect send success/failure;
- conservative application safety throttles per account — product defaults, not LinkedIn-published limits and no guarantee against restrictions (campaigns may only lower them).

The product must not claim that UI automation is risk-free or officially supported.

### Approvals

- `approve_each` — default;
- `approve_campaign` — explicit opt-in; approves a campaign version plus a reviewed sample of drafts; further drafts are auto-approved only if they pass automated checks, otherwise they fall back to per-item approval;
- batch review queue with keyboard navigation;
- edit before approval;
- skip;
- reject;
- audit event for approval;
- content hash so edits after approval invalidate previous approval.

### Inbox

MVP inbox is email-first:

- replies;
- campaign/prospect linkage;
- unread/read;
- simple AI intent classification;
- manual response drafting;
- stop/continue sequence controls.

LinkedIn: reply check before follow-ups (see above). Full LinkedIn inbox sync is deferred.

### Observability

- structured logs;
- per-run correlation IDs;
- action timeline;
- screenshots on browser failure;
- state transitions;
- job queue status;
- bounded retention controls.

### Distribution

- signed, notarized macOS `.app`;
- first-run setup wizard (Chrome detection, AI key, email account, first browser profile);
- no Docker or other service prerequisites.

## Explicitly deferred

See `24-OUT-OF-SCOPE.md`.

Notably deferred:

- lead discovery engine;
- recorder / teach mode;
- Chrome extension;
- full LinkedIn inbox sync;
- remote adapter-pack update feed;
- Microsoft Graph adapter;
- anti-detect;
- CAPTCHA solving;
- arbitrary visual workflow builder;
- custom Chromium fork;
- mobile apps.

## Supported platform

Initial supported host:

- macOS;
- Apple Silicon is the primary target;
- Intel macOS support is best-effort.

Windows/Linux must not influence MVP implementation unless the abstraction is nearly free. The TypeScript/Electron/SQLite stack keeps a later Windows port cheap.

## Definition of MVP completion

The MVP is complete only when all acceptance criteria in `23-ACCEPTANCE-CRITERIA.md` pass against a clean installation of the packaged app.
