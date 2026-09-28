# 17 — Campaigns

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
- stop conditions: reply from this contact; reply from another contact of the company (if enabled, strong match or user-confirmed only); opt-out; bounce;
- channel account limits and adapter kill switches.

A blocked action is recorded with the blocking rule and the enrollment is stopped or deferred according to the rule.

## Scheduling

Requirements:

- timezone-aware: quiet hours/active windows evaluated in the **recipient's** timezone when known (contact → company → campaign timezone fallback);
- campaign active windows;
- daily action limits per channel account;
- next-action timestamps stored on enrollments; due work becomes jobs;
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
