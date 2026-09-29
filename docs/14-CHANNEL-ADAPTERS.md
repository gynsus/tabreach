# 14 — Channel Adapters

## Purpose

A campaign expresses intent. A channel adapter implements channel-specific execution.

## Contract

Intent side (core, TypeScript interface):

```text
capabilities(account)            -> supported intents, execution modes, limits
validate(intent, context)        -> ok | problems (launch-time and pre-send)
prepare(intent, context)         -> PreparedAction (content, target snapshot, preview)
execute(prepared, mode)          -> ExecutionResult (may dispatch browser tasks)
verify(execution)                -> completed | failed | unknown
reconcile(sideEffect)            -> completed | not_sent | unknown
```

Adapters also expose policy metadata: which intents are critical, default and allowed execution modes, default limits.

For browser channels, `prepare`/`execute`/`verify`/`reconcile` are implemented by dispatching browser tasks to the worker (`07-BROWSER-RUNTIME.md`). The page-level logic lives in the worker and in adapter packs; core never sends individual clicks.

## Common action intents

```text
SEND_EMAIL
SEND_MESSAGE
SEND_CONNECTION_REQUEST
CHECK_CONVERSATION
VISIT_PROFILE
SUBMIT_FORM
OPEN_URL
```

Not every adapter supports every intent.

## Email adapters

Browser automation is never used for email when an API/protocol can perform the operation (ADR 008).

Two transports behind one `EmailTransport` interface (ADR 016):

### Gmail API — OAuth client options (ADR 016)

How tokens are obtained is the same in every option and needs no server: the app opens the system browser (never an embedded webview) at Google's consent screen, Google redirects to a short-lived loopback listener on `127.0.0.1:<ephemeral port>`, the app exchanges the code (with PKCE and `state`) for a refresh token, and stores it encrypted locally. Running locally is not an obstacle: Google verifies the **OAuth client registration**, not where the code runs, and recommends the loopback flow for desktop apps.

What differs is **whose OAuth client** is used:

| Option | Who registers the client | Verification | User experience | Stage |
|---|---|---|---|---|
| A. User-owned client | the user, in their own Google Cloud project | not required under Google's personal-use exception (only that user uses it) | ~10–15 min guided setup; one-time "unverified app" warning | MVP |
| B. Workspace Internal client | the user/admin, in their Google Workspace org | not required for Internal apps | no warning; tokens do not expire due to Testing status | MVP (wizard branch) |
| C. Publisher-owned verified client | TabReach | brand verification for sensitive scopes; restricted-scope verification (usually incl. an annual third-party security assessment) for `gmail.readonly` | one click "Connect Gmail" | later, when distributing to external users |

Scope classes (the wizard states this explicitly): `gmail.send` is **sensitive**; `gmail.readonly` is **restricted**. `gmail.readonly` is needed for reply ingestion and Sent reconciliation.

#### A/B — wizard steps

Implemented in Phase 3b (Settings → Email accounts → Connect Gmail); see ADR 016 "Implementation".


1. create a Google Cloud project;
2. enable the Gmail API;
3. configure the OAuth consent screen — **Internal** if the account belongs to a Google Workspace org and the user may create Internal apps (option B), otherwise **External** (option A);
4. External only: set publishing status to **In production**. In "Testing" status Google typically expires refresh tokens after 7 days. A user-owned project used only by that user may qualify for Google's personal-use verification exception; it remains subject to the unverified-app warning, user caps, Workspace administrator policies (an admin may block unverified third-party apps) and Google's OAuth policies;
5. create an OAuth client of type **Desktop app**;
6. paste the client ID (and client secret — not confidential for desktop clients, but still stored encrypted) into the app.

If a Workspace admin blocks the user's own client, the fallback is IMAP/SMTP (if allowed by the admin) or asking the admin to allow the client.

#### C — publisher-owned client (later stage)

Prerequisites to research and budget before starting (verify against Google's current policy; they change):

- verified homepage and domain, privacy policy, demo video, brand verification;
- restricted-scope review for `gmail.readonly`; whether the annual security assessment applies to an app that stores Google user data only on the user's device (Google's requirement is tied to accessing/storing data from or through servers — confirm the current wording);
- Google API Services User Data Policy / Limited Use: TabReach sends email content to the user's own AI provider for classification and drafting. This is a transfer to a third party for a user-facing feature and must be disclosed; data must not be used to train generalized models.

The transport code is identical for A, B and C; only the client ID source differs (user-provided vs built-in). Adding C requires no architectural change.

Responsibilities:

- send (raw RFC 5322 with app-generated `Message-ID`);
- provider message/thread IDs;
- reconciliation: search Sent by `rfc822msgid:<Message-ID>` with several delayed attempts (search indexing lags); messages sent through the API always land in Sent, so this usually resolves the outcome;
- reply ingestion by polling (history API);
- error mapping (auth expired → `AUTH_REQUIRED`, quota → retryable with backoff).

### IMAP/SMTP — any provider

- Implemented in Phase 3a (ADR 023): the `Message-ID` is derived from the side-effect ledger key; SMTP runs in explicit stages so that only failures while connecting/logging in or explicit refusals count as `not_sent`; reconciliation searches the IMAP `\Sent` folder, waits up to 10 minutes for index lag on servers that keep sent mail, and leaves `unknown` for a person where absence proves nothing. Server presets in the UI: Gmail, Outlook, iCloud, Yandex, Mail.ru.
- SMTP send with app-generated `Message-ID`; append to Sent via IMAP if the server doesn't do it. Submission and `APPEND` are separate operations, so a crash between them (or a lost SMTP response after `DATA`) leaves the outcome `unknown` — this is expected and handled by the ledger, never by re-sending;
- IMAP polling (or IDLE) for replies;
- reconciliation: IMAP `SEARCH HEADER Message-ID`;
- auth: OAuth2 (XOAUTH2) where the provider requires it; otherwise app password (e.g. Gmail app passwords require 2-Step Verification);
- works as the simplest fallback for Gmail and as the path for other providers until dedicated adapters exist.

### Common email behaviour

Implemented in Phase 3c for IMAP accounts (ADR 024): polling every 2 minutes from the moment of connecting, thread / contact-address / domain-only matching, rule-based classification, bounces, stop on reply. AI classification follows in Phase 4.


- **Reply matching** with explicit strength:
  - `thread` — provider thread ID or `In-Reply-To`/`References` → strong;
  - `contact_address` — exact address of a known contact → strong;
  - `domain_only` — sender domain matches a company → **possible reply**: shown in the inbox for the user to confirm or dismiss; never triggers an automatic company-wide stop.
  - Not replies at all: auto-replies and bulk mail (`Auto-Submitted`, `Precedence: bulk/list`, `List-Id`, out-of-office), and role/no-reply senders (`noreply@`, `billing@`, `jobs@`, ... configurable list) unless they come in the campaign thread.
- **Bounces**: detect DSNs (`multipart/report; report-type=delivery-status`, mailer-daemon senders); hard bounce → contact `email_status=bounced`, suppression entry, stop sequence.
- **Classification**: interested / not interested / out-of-office / opt-out / bounce / other. Opt-out → suppression (FR-POL-005). Out-of-office does not stop by default; it may delay.
- **Headers**: optional `List-Unsubscribe` (mailto) configured per account; sender identity/signature per account.
- **Limits**: per-account daily send cap and minimum spacing between sends.

Microsoft Graph adapter can be added later behind the same interface. Do not bake Gmail-specific assumptions into domain services.

## Website form adapter

Browser channel; runs as worker tasks.

Responsibilities:

- find likely contact page/form (adapter pack for generic heuristics + semantic assistance);
- map standard fields;
- prepare payload and screenshot;
- detect challenge;
- submit under policy and execution mode (default `auto` after approval);
- verify result, or report `unknown`.

Standard semantic fields:

```text
name
first_name
last_name
email
phone
company
website
subject
message
consent
```

Consent/marketing checkboxes must not be ticked without an explicit configured meaning. Unmapped required fields → `needs_human`.

### Implementation status (Phase 6a, 2026-09-29)

Worker side (`packages/browser-worker/src/forms.ts`), with the generic knowledge as data in the `web-form` pack (`forms`: contact link texts, contact paths, EN/RU phrases per field meaning, success and refusal texts; ADR 017):

- `form.prepare` (PrepareFormSubmission): opens the website; the contact form is the visible form with something to write in and an email, without a password or search field (a login form is never taken); otherwise it follows up to three same-site links whose text or path says "contact", or the pack's contact paths, and then buttons that open a dialog. Fields are described by a page script (labels, `aria-label`, placeholders, names, `autocomplete`, types) and mapped by `autocomplete`, then type, then phrases matched from the start of a word, most specific first. Invisible fields (honeypots) are never filled; check boxes are consent or nothing and are never ticked; selects and radios are left alone. The form is filled and photographed for approval; nothing is sent. `needs_human` for a required field without a value (`form.unmappedRequired`), a required consent (`form.consentRequired`) or a challenge (`form.challenge`).
- `form.submit` (ExecuteFormSubmission): opens the same form (and its dialog), refuses it if its field signature changed since approval (`form.changed`), writes exactly the approved values and checks them, refuses what the page itself would refuse (`checkValidity`), needs exactly one visible submit button in `auto`, then the `about_to_commit` checkpoint, a re-check, and one press. In `auto` a challenge means nothing is pressed (`needs_human`); in `assisted` the person solves it and presses. Success needs the site's success text after a navigation, the form's removal or a new message; a field marked invalid or a refusal alert on the form is a verified "not sent" (`task.rejected`); anything else is `unknown`.
- Fixtures (`fixtures/sites/public/forms`): link discovery with a login form beside the contact form, a form drawn by a script with placeholders only, a required unknown field, a Russian form with a required consent, a reCAPTCHA form, a dialog form, and site reactions thank-you page / inline message / refusal / silence.
- Core integration, approval preview and semantic resolution: Phase 6b and 6c.

### Implementation status (Phase 6b, 2026-09-29)

`FormService` (core) keeps the form sender, runs `form.prepare` in the sender's profile before approval and stores the preparation; the `web_form` channel is a `BrowserActionChannel` whose dispatch is `form.submit` with the run's latest preparation, so the ledger turns `executing` only at the checkpoint. The approval (`approval.form`) lists every field with the value TabReach writes, what stays empty, required fields the person fills, consent boxes it never ticks, who presses Send, and the photo of the filled form. See docs/13 and docs/17 for the state machine and campaign rules. Per-contact channel eligibility is derived (a form step needs the company's website); a separate eligibility table was not needed.

### Implementation status (Phase 6c, 2026-09-29)

Fields the phrases miss and a contact page no link names are resolved by AI from a closed list (ADR 013, docs/15), once per preparation; without AI they go to the person. Fixtures: a form with unfamiliar labels, and a site whose form is behind "Talk to sales". A page answering 4xx/5xx is not searched for a form.

## LinkedIn browser adapter

Isolated module with a kill switch (setting, fails closed).

Execution modes: `assisted` (default), `manual`, `auto` (explicit opt-in per action class: message, connect).

Responsibilities:

- open known profile URL;
- recognize supported page states (adapter pack; allowlist);
- verify target identity (URL + name) before any critical action;
- check the conversation for new inbound messages before every follow-up (mandatory; reply → stop step, record reply event);
- prepare message / connection note;
- perform or assist the action;
- detect login/challenge states;
- verify UI outcomes;
- respect per-account limits.

**Application safety throttles** (settings, conservative; campaigns may only lower them; raising requires an explicit settings change with a risk warning). These are TabReach product defaults, **not LinkedIn-published limits and not a guarantee against account restrictions** — LinkedIn does not publish exact numbers and restricts based on volume, short-term bursts, ignored/pending invitations and suspected automation. The values below are initial placeholders to be tuned from real use; they live in the adapter pack, not in code:

```text
connection requests:  15 / day, 80 / week
messages:             30 / day
profile visits:       60 / day
minimum spacing:      90 s between critical actions (randomization not used for evasion;
                      spacing exists to keep actions human-reviewable)
```

The adapter must not introduce global stealth/bypass behaviour into the worker.

The product UI states that LinkedIn prohibits third-party software that automates activity on its site, that account restrictions are possible, and that `assisted` mode reduces the degree of automation and the risk but does **not** make the integration officially permitted.

### Adapter packs (ADR 017)

LinkedIn's UI changes often. Page states, locators (with UI-language variants), verification rules and default limits live in a versioned adapter pack, not in code. The adapter code is a state machine that consumes the pack.

- MVP: packs are bundled with the app, schema-validated at load, versioned; the pack version is recorded on every action event.
- Post-MVP: packs can be delivered as signed files (Ed25519, public key in the app) without an app release.

## Webhook adapter

Lightweight integration output:

- send structured event to a configured URL;
- HMAC-signed payload;
- bounded retries;
- idempotency key header.

Useful for integrating external CRM/tools without implementing them.

## Capability discovery

Before campaign launch, validate that selected accounts/adapters support all sequence intents and execution modes, and that adapters are enabled.

Fail early rather than discovering missing capability mid-campaign.
