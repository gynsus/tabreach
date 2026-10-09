# 17 — Campaigns

## Implementation status (Phase 4c, 2026-09-29)

- A message step is `template` (subject and body with placeholders) or `ai`: the user writes instructions (offer, tone, call to action, language) and a signature. AI steps research the company first (research older than 30 days is refreshed; a failed research is not retried for a day and the message is written without facts), then `draft.write` v2 writes subject and body from the verified facts; the signature is appended by TabReach, never by the model. Fact refs such as `(F3)` and a closing line repeating the start of the signature are removed from what the model wrote.
- Every draft version gets the automated checks (ADR 025): grounding, length, forbidden phrases, links, signature, target. They are shown in the approval together with the facts the draft used.
- `approve_campaign`: after `sampleSize` messages of the campaign version were approved by hand, a template or AI draft that passes every check is approved by the policy (`decided_by = campaign_policy`, `scope = campaign`); any failing draft waits for a person. An edited draft always does.
- Launch validation: an AI step needs instructions and a stored AI key.
- Phase 6b: a message step may use channel `web_form` — the company's website contact form. Its target is the company's website (without query or fragment); the form sender's details (Settings → Website forms: a browser profile, name, email, phone, company, website) and the message go into the form. `executionMode` is `auto` (TabReach presses Send after approval) or `assisted` (the person presses it in the browser window); email and test steps are always `auto` (`mode.autoOnly`). A form with a required field TabReach cannot fill, a required consent or a CAPTCHA is always `assisted` and never approved by the campaign policy. Launch needs a form sender (`forms.senderRequired`). Pacing of the form channel: two minutes apart, 40 a day. An email's bounce does not stop a form step. A company's form is written to once per campaign step, however many of its people are enrolled; a domain on the do-not-contact list also covers the company's website host; websites on this machine or in the local network are never opened.
- Phase 7b: a message step may use channel `linkedin` with `linkedinAction` `connect` (an invitation; the text is its note, up to 300 characters, optional) or `message` (to a connection). The target is the contact's LinkedIn profile; a contact without a full name is stopped (`invalid_target`: the page's name is checked). Steps start `assisted`; `auto` needs the opt-in for that action class (`linkedin.autoNotAllowed`). Launch needs the adapter on (`linkedin.disabled`). An invitation to someone already invited or connected completes the step without sending; a message to someone not connected waits a day at a time and stops after two weeks (`not_connected`); an answer in the thread stops the enrollment (`replied`) — before the campaign has invited or written to the person, their unanswered message stops it as `unanswered_message` instead (no reply is recorded; docs/14); a page about someone else stops it (`invalid_target`); signed out, a security check or an unreadable thread wait an hour.
- Live check with `deepseek/deepseek-v4.1-flash` (2026-09-29, a company with 20 verified facts): about 2k input and 0.7–0.8k output tokens, 4–8 s per draft. v1 put fact refs in the text, added its own sign-off and opened a first message with "continuing our conversation"; v2 and the clean-up fixed all three.

## Campaign model

A campaign contains a mutable draft configuration and immutable launched versions.

Launching produces a `CampaignVersion`. Running enrollments always point to an immutable version. Editing a running campaign and re-launching creates a new version; existing enrollments stay on their version unless the user explicitly migrates them.

## Required campaign settings

- name;
- goal;
- target/ICP rules;
- selected sender/channel accounts;
- sequence steps with execution modes;
- research instructions;
- message instructions;
- approval mode;
- stop-on-reply (contact-level; company-level default from policy settings);
- per-day/per-period limits;
- active windows and campaign timezone;
- optional webhook.

## Approval modes

### `approve_each`

Default.

Every critical side effect creates an approval. Approvals are processed in a batch review queue (keyboard: approve / edit / skip / reject / next), showing the draft, draft check results, target snapshot, evidence used, and — for browser actions — the prepared screenshot with highlighted target.

### `approve_campaign`

For AI-personalised messages every draft is different, so "approving the campaign" must be defined precisely:

1. the user approves the campaign version (instructions, sequence, execution modes, limits);
2. the user reviews a sample of generated drafts (default 5, configurable) and approves them individually;
3. subsequent drafts are auto-approved **only if all automated draft checks pass**:
   - grounding (personalised specifics trace to verified facts);
   - length bounds;
   - forbidden phrases list;
   - no URLs other than allowed ones, no additional recipients;
   - required signature present;
   - target identity snapshot matches;
4. any failing draft falls back to `approve_each` for that item.

This does not override:

- security challenges;
- target mismatch;
- content edits after approval;
- contact policy (suppression, caps, stop conditions);
- adapter kill switch or policy block;
- global pause.

Execution mode is independent: `approve_campaign` + `assisted` means drafts are auto-approved but the user still clicks Send in the browser.

## Sequence step config

Example:

```json
{
  "type": "send_email",
  "executionMode": "auto",
  "delaySeconds": 259200,
  "config": {
    "templateMode": "ai_personalized",
    "stopIfReplied": true,
    "replyAsThread": true
  }
}
```

## Contact policy at runtime

Before every critical action (in the workflow's final pre-send check):

- suppression list (email, domain, company, profile URL);
- per-contact channel eligibility;
- frequency caps across all campaigns (per contact and per company);
- reply hold: a contact who replied (or, with the company stop on, whose colleague replied) is not contacted by any campaign until the user allows it on the contact (ADR 021, audit 3.5);
- stop conditions: reply from this contact; reply from another contact of the company (if enabled, strong match or user-confirmed only); opt-out; bounce;
- channel account limits and adapter kill switches.

A blocked action is recorded with the blocking rule and the enrollment is stopped or deferred according to the rule.

Definitions and defaults (ADR 021 §6, settings key `policy`):

- a **touch** is a side effect toward the contact/company in status `executing`, `completed` or `unknown` (an uncertain send counts);
- caps: 1 touch per contact per 3 days, 3 touches per company per 7 days — follow-ups of the same campaign count too, so sequence delays shorter than the cap wait for it;
- company-level stop on reply: on (strong matches only, see `14-CHANNEL-ADAPTERS.md`);
- active window: Monday–Friday 09:00–18:00 in the recipient's timezone; per-campaign override;
- minimum spacing per email account: 60 s;
- a domain suppression also covers its subdomains; a company suppression covers all its contacts;
- all checks run in the final pre-send step, in the same transaction that reserves the side-effect ledger entry.

## Scheduling

Requirements:

- timezone-aware: quiet hours/active windows evaluated in the **recipient's** timezone when known (contact → company → campaign timezone fallback);
- campaign active windows;
- daily action limits per channel account;
- next-action timestamps stored on enrollments (the enrollment owns delays between steps); due work becomes jobs;
- deterministic delay calculation;
- no busy polling per enrollment.

## Sleep, downtime and catch-up

The app only runs while the Mac is awake and the app is open.

- Optional setting: keep the Mac awake while campaigns are active (`powerSaveBlocker`).
- On resume/start, overdue actions are re-planned:
  - if still inside the current permitted window, they run subject to limits and minimum spacing;
  - otherwise they move to the next permitted window;
  - catch-up never bursts: minimum spacing and daily limits apply as usual.
- Delays are measured from the actual time of the previous step, so a late step does not compress the following delays.

## Limits

Campaign limits are product safety/quality controls, not bot-evasion controls.

At minimum:

- max actions/day by channel account;
- minimum spacing between critical actions per account;
- max concurrent browser tasks (1 per profile);
- max research concurrency;
- quiet hours;
- manual global pause.

## Stop conditions

- inbound reply (contact; company-level if enabled — strong matches only, domain-only matches need user confirmation);
- opt-out;
- bounce;
- manual stop;
- invalid target;
- permanent provider error;
- campaign pause does not permanently stop.

## Launch validation

Before launch validate:

- campaign has at least one target;
- all steps have supported adapters and allowed execution modes;
- adapters enabled (kill switches);
- channel accounts healthy enough (authorized, profile logged in);
- required message/research settings exist;
- approval policy explicit;
- limits valid.

Show a dry-run preview for one target.
