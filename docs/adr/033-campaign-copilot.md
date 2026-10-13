# ADR 033 — Campaign copilot: a campaign drafted from the user's own words

**Status:** Accepted (2026-10-13, Phase 9c)

## Context

Setting up a campaign means filling the goal, ICP, research instructions, a sequence of messages, conditions and tasks, delays, sending hours and the approval mode (docs/16, docs/17). For the target user — a founder or freelancer doing their own outreach — this is the steepest part of the product. The AI gateway, the per-campaign budget, the dry run and the launch checks already exist, so a model can propose the whole setup while the existing validation decides what is allowed.

The idea was discussed in a UI and AI review on 2026-10-13. The direction agreed there: the model proposes, the policy decides what is allowed, the user decides what goes live.

## Decision

- **Three stages: intent, questions, plan.** The user describes in their own words whom they want to reach and why. One AI call (`campaign.intent`) returns its understanding plus 0–5 questions, each with suggested answers. The user answers them all on one screen. A second call (`campaign.plan`) returns a `CampaignProposal`. At most one more round of questions is allowed, and only when the answers still leave a blocking ambiguity. In the usual case that is two calls.
- **The proposal is not a campaign.** `CampaignProposal` (Zod, `packages/protocol`) carries the goal, ICP, research instructions, steps, delays, the approval mode, and the model's `assumptions`, `warnings` and `unsupported` requests. Core turns it into a campaign config through the same schema and launch checks as the editor, then applies fixed rules the model cannot change:
  - the approval mode is `approve_each`, or `approve_campaign` only with the default sample;
  - LinkedIn steps are `assisted`;
  - form steps are `assisted` unless the user changes them in the editor;
  - no sending or LinkedIn limit is raised;
  - the qualification condition never uses `contains` (audit 8d.5).

  A request that breaks a rule is shown as "asked for → not available → replaced with", for example an automatic LinkedIn message replaced by a task.
- **A plan screen before the editor.** The plan is shown in plain words: the goal, the audience, what research looks for, the steps with their days, and the safety settings. Next to them are the requests that were replaced, the model's assumptions and warnings, and what the launch checks would still refuse. "Create draft" saves the plan as an ordinary never-launched draft with `campaigns.create` and opens it in the editor, where the dry run (`campaigns.preview`, docs/17) is one click away. Deleting the draft stays allowed after a dry run (audit 8d.5). The copilot never launches a campaign and never enrolls anyone. *Implemented as:* the dry run runs from the editor rather than from the plan screen, because it needs a saved campaign and the draft is saved by the same click.
- **No contacts yet.** TabReach does not find lists. The plan says which CSV columns this campaign needs (for example the website for research and the first name for personalisation) and offers the import.
- **Cost.** The calls go through the AI gateway with the monthly budget. They belong to no campaign until one is created, as with the person and company forms (docs/15).
- **Untrusted text.** The user's description is the user's own words, not page content. Imported data that reaches the prompt, such as tags and company names, is fenced as untrusted (docs/15).

## Alternatives

- **A free chat** that asks questions one at a time: slower, harder to bound in cost and rounds, and harder to test.
- **The model writes the campaign config directly:** business rules would then depend on the prompt. A proposal that is validated and normalised keeps them in code.
- **Launch from the copilot:** saves a click, but a campaign that sends should always pass through the user's own launch.

## Consequences

- New prompts `campaign.intent` v1 and `campaign.plan` v1 (docs/15) and new protocol messages `copilot.intent` and `copilot.plan`. A "Build with AI" button sits on the Campaigns page next to "New campaign" and opens `#/campaigns/copilot`.
- Without an AI key the copilot refuses before any call (`ai.no_key`), so no failed call is logged.
- `CampaignService.problems(config)` exposes the launch checks without throwing; launch still refuses through them.
- Tests run the validation and the fixed rules against hand-written proposals, including hostile ones, without calling a model.

## Migration impact

None: a proposal is not stored. A created campaign is an ordinary draft.
