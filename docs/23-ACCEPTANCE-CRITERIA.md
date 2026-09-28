# 23 — MVP Acceptance Criteria

The MVP is releasable only when these criteria are demonstrably satisfied on a clean installation of the packaged app.

## Installation

- [ ] Signed, notarized `.app` installs on a clean supported macOS account without Docker or other prerequisites except Google Chrome.
- [ ] Setup wizard detects Chrome, stores the AI key, connects an email account and creates a first profile.
- [ ] Status view shows health of core, worker, database and Chrome.
- [ ] The app exposes no persistent network listeners; the only listener is the short-lived single-use OAuth loopback on `127.0.0.1` during authorization.

## Prospects and policy

- [ ] CSV import preview works; invalid rows are reported.
- [ ] Duplicate handling is deterministic.
- [ ] Prospect can be edited/exported.
- [ ] Suppressed contacts/domains are never contacted (checked at send time).
- [ ] Frequency caps across campaigns are enforced.
- [ ] Company-level stop on reply works when enabled, triggered only by strong matches (thread or exact known contact) or user confirmation.

## Browser profile

- [ ] Dedicated managed profile can be created.
- [ ] User can manually authenticate in visible Chrome.
- [ ] Closing/reopening preserves authenticated state.
- [ ] App never uses the user's main Chrome profile.
- [ ] Concurrent automation ownership is prevented.
- [ ] Research never runs in a channel identity profile.

## Browser worker

- [ ] Tasks work against fixtures; every action is correlated and visible in the timeline.
- [ ] Adapters act only in recognized states; unsupported state stops.
- [ ] Failed task produces sanitized diagnostics.
- [ ] User can pause immediately; emergency stop works.
- [ ] Manual control blocks automation.
- [ ] Overlay can pause but cannot resume/approve.

## Human intervention and execution modes

- [ ] Fake CAPTCHA fixture triggers `WAITING_FOR_HUMAN`.
- [ ] No automatic CAPTCHA solution path exists.
- [ ] Returning control revalidates state.
- [ ] If the user completed the action manually, the system avoids a duplicate (UI verification or user confirmation).
- [ ] `assisted` mode: highlighted control, user click detected and verified; timeout leads to outcome confirmation.
- [ ] `manual` mode: content shown, outcome confirmation recorded.

## Research

- [ ] Company research runs within configured limits.
- [ ] Every sourced fact has an evidence link and a verified verbatim quote.
- [ ] Fact and inference are distinguishable.
- [ ] Re-run produces a new version.

## Campaign and workflow

- [ ] Campaign can be versioned/launched; running campaign uses immutable snapshot.
- [ ] Pause/resume works.
- [ ] Delay scheduling survives app restart and Mac sleep; catch-up does not burst.
- [ ] Quiet hours respect recipient timezone when known.
- [ ] Duplicate job execution does not duplicate a critical side effect.
- [ ] Editing a draft after an `unknown` outcome does not cause a second send.

## Approvals

- [ ] Critical action under default policy cannot execute without approval.
- [ ] Approval binds target + content hash; editing invalidates it.
- [ ] Batch approval queue works by keyboard.
- [ ] `approve_campaign` is explicit, auditable, requires sample review, and falls back to per-item approval on failed checks.

## Email

- [ ] Gmail account connects through a user-owned OAuth client (wizard, incl. Workspace Internal path); refresh works beyond 7 days when the client is in production status; the wizard explains scope classes and the unverified-app warning.
- [ ] IMAP/SMTP account connects.
- [ ] A crash around email submission never causes an automatic duplicate: the action is reconciled to `completed` or `not_sent` (Message-ID lookup in Sent, with delayed retries), or remains `unknown` and is surfaced; `unknown` is never automatically re-sent.
- [ ] Provider IDs saved; reply ingested and matched.
- [ ] Bounce detected and handled.
- [ ] Opt-out reply creates suppression.
- [ ] Stop-on-reply works; domain-only matches never trigger an automatic company-wide stop; auto-replies and role/bulk senders are not treated as replies.
- [ ] Plaintext secret material is never present in logs, events, diagnostics, backups or exports. Portable exports exclude the `secrets` table; local recovery backups may contain `safeStorage` ciphertext only.

## Website form

- [ ] Standard and dynamic fixture forms discovered and filled.
- [ ] Final payload inspectable before submission under `approve_each`.
- [ ] Success is verified or explicitly `unknown`.
- [ ] Challenge fixture requires human.
- [ ] Consent checkboxes are never ticked without configuration.

## LinkedIn adapter

- [ ] Isolated module and kill switch (fails closed).
- [ ] `assisted` is the default mode; `auto` requires explicit opt-in.
- [ ] Known target identity is verified before critical action.
- [ ] Follow-up is not sent when a new inbound reply exists.
- [ ] Unsupported state stops rather than blind-clicking.
- [ ] Security challenge stops for human.
- [ ] Application safety throttles enforced; campaigns cannot exceed them; UI states they are product defaults, not LinkedIn-published limits.
- [ ] Adapter-pack version recorded on actions.
- [ ] Fixture-based tests exist.
- [ ] Product UI shows the platform risk and does not claim safety/undetectability.

## AI

- [ ] All provider calls go through the core AI gateway; the worker holds no key.
- [ ] Machine outputs are schema validated.
- [ ] Prompt templates versioned.
- [ ] Page/email content cannot authorize side effects or change recipients.
- [ ] Semantic resolution only picks among enumerated candidates and is bounded.
- [ ] Budgets enforced; usage/cost visible.

## Security

- [ ] Renderer sandboxed; IPC schema-validated.
- [ ] Secrets encrypted via safeStorage; never logged.
- [ ] Browser profiles excluded from diagnostics, backups and exports.
- [ ] Local recovery backup restores a working app on the same Mac user (credentials included); portable export contains no secrets.
- [ ] Electron fuses/hardened runtime configured for release.
- [ ] Sensitive form values redacted.

## Recovery

- [ ] Worker/Chrome crash recovery tested.
- [ ] Crash after critical click but before verification handled without automatic duplicate.
- [ ] Network retry bounded.
- [ ] Dead jobs visible and actionable.

## Release

- [ ] Full test suite passes.
- [ ] No critical/high known security defects.
- [ ] User docs exist, including Gmail OAuth client setup and LinkedIn risk notice.
- [ ] Architecture docs match implementation.
