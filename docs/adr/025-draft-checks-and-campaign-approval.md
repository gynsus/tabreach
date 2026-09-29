# ADR 025 — Draft checks and campaign approval

**Status:** Accepted (2026-09-29, Phase 4c). Implements docs/17 "approve_campaign" and docs/15 "Grounding verification".

## Context

AI drafts differ per recipient, so approving a campaign cannot mean approving its text. docs/17 lets drafts be approved by the campaign's policy after a hand-reviewed sample, but only if every automated check passes. The checks decide what reaches a prospect without a person reading it, so they must be predictable, testable and impossible to talk out of a verdict.

## Decision

- **Checks run on every draft version** (template, AI or edited) and are stored with it in `draft_checks`, keyed by the draft id — a version's content never changes, so there is nothing to re-bind:
  - `grounding` — every number and every capitalised word that does not start a sentence must appear in a source: the facts the draft used (claim and quote), the contact's and company's fields, the step's instructions or template, the signature, or messages already sent. Numbers compare by their digits (`1 490 000` = `1490000`); words compare by a stem, so Russian case forms match (`Москве` / `Москва`). Hyphenated compounds are checked by their capitalised parts, and count by their parts in the sources (`B2B-рассылок` supports `B2B`). Unsupported items are listed.
  - `length` — at least 20 characters, at most the campaign's `maxLength` (default 1500), signature included.
  - `forbidden_phrases` — case- and whitespace-insensitive.
  - `links` — URLs, bare domains and email addresses only on `allowedLinkDomains` (default: none); the signature is exempt, the user wrote it.
  - `signature` — the body ends with the step's rendered signature.
  - `target` — the address the draft was written for is still the contact's address.
- **Grounding is deterministic, not a second model call.** A model judging a model's text can be persuaded by the same injected material; a rule cannot. It errs towards failing (a sentence-initial name or a rephrased number is not recognised), and a failure only means a person reviews the draft.
- **Auto-approval** (`approve_campaign`): a draft whose origin is `template` or `ai`, with every check passed, once the user has approved `sampleSize` (default 5) messages of the same campaign version, gets an approval row with `status = approved`, `decided_by = campaign_policy`, `scope = campaign`, and the audit action `approval.auto_approved`. Nothing else changes: policy, pre-send checks, the ledger and the content hash apply as for a person's approval.
- **Edits always go to a person**: a revised draft has origin `user` and is never auto-approved.
- Facts reach the model only as untrusted fenced material; the instructions are the user's. The model's `usedFacts` decides which facts are attached, and so which specifics the draft may contain.

## Alternatives

- A second AI call to judge grounding: semantic, but non-deterministic, costs a call per draft and can be steered by injected text.
- No auto-approval (approve_each only): safe, but defeats personalisation at volume, which docs/17 explicitly allows.

## Consequences

- Some grounded drafts fail grounding (a name at the start of a sentence is skipped rather than checked, a paraphrased figure fails); they wait for a person, which is safe.
- The checks are shown in the approval, so the user sees why a draft was not auto-approved.

## Migration impact

Migration 14 adds `message_drafts.origin` (existing drafts read as `template`) and the `draft_checks` table. Existing campaign configs get the new fields' defaults when parsed.
