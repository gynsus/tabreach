# 15 — AI Architecture

## Goal

AI assists with interpretation, research, drafting, classification and browser target resolution. It does not own unrestricted side effects.

## AI gateway

There is exactly one component that calls AI providers: the **AI gateway** in core.

- The browser worker never holds an API key and never calls a provider; it sends `ai.resolveTarget` requests to core.
- The renderer and main never call providers.
- The gateway enforces budgets, records usage and cost, applies redaction, and validates outputs.

## Implementation status (Phase 4a, 2026-09-29)

- `packages/core/src/ai/`: `AiGateway` (the only caller), `AnthropicProvider` (Messages API over `fetch`; structured output as a forced tool call whose `input_schema` is the template's Zod schema converted with `z.toJSONSchema`), versioned `PromptTemplate`s, `untrusted()` fencing with a per-call nonce (closing tags inside the material are defused).
- Settings (`ai`): provider, model per use case (suggested per provider on switch: `DEFAULT_AI_MODELS`), prices per model entered by the user, monthly budget. Each provider has its own key (`SecretStore` secret `ai_api_key`, referenced by the `ai.key.<provider>` setting; the pre-provider `ai.key` reference is still read as Anthropic's), so switching provider keeps the other keys. The reference also keeps the key's last four characters (shown as `…a1b2` so the user can tell which key is stored). Saving a key points the reference at the new secret before deleting the old one; on start, `ai_api_key` secrets no reference points at are deleted.
- Providers (2026-09-29): `anthropic` (`AnthropicProvider`), and `openrouter` / `openai` through `OpenAiCompatibleProvider` — `POST {base}/chat/completions`, structured output as `response_format: json_schema` with `strict: true` (JSON Schema keywords strict mode rejects, such as `minLength` or `maximum`, are stripped; Zod still validates the answer). For OpenRouter the request asks for `provider.require_parameters` (only routes that honour the schema) and `usage.include`, and the reported `usage.cost` is recorded when the user entered no price. HTTP 402 maps to the `payment` error. An answer cut off at the token limit (`finish_reason: length`) is `invalid_output` and gets the one repair attempt. Token limits leave room for models that reason before answering (key check 1 000, reply label 1 000, research synthesis 6 000); only used tokens are billed. Suggested OpenRouter model: `deepseek/deepseek-v4.1-flash`. Keywords strict mode drops are restated in the field's description (`(maxItems: 20)`), so the model still sees the limits. Logs record reasoning tokens when the provider reports them, and for a schema mismatch the failing field paths and issue codes (never values).
- `ai_calls` records template key/version, model, status, tokens, estimated cost and latency — never prompts or content. Cost and the budget work for models with a price set or a provider-reported cost (OpenRouter); token counts are always shown. A call without a cost makes the month's total unknown in the display, but the budget still counts every known cost (audit 4.5).
- First use case: reply labels (`reply.classify` v1) — interested / not interested / opt-out / out-of-office / other. An opt-out adds the sender to the do-not-contact list. Without a key, replies are not sent anywhere.

- Drafting (Phase 4c): `draft.write` v2 (drafting model; v2 forbids fact refs and a sign-off in the text and a pretended earlier conversation). Input: the user's instructions (trusted), recipient fields, the company's verified facts as `F1…` refs (each fenced as untrusted: they come from web pages), and the messages already sent to the recipient. Output: subject, body without signature, and the refs used; only those facts are attached to the draft. Grounding is checked deterministically (ADR 025).

## Provider abstraction

Provider-neutral interface for:

- structured generation (schema-validated JSON);
- text generation;
- classification;
- optional vision (screenshot input for target resolution, off by default).

Anthropic, OpenRouter and OpenAI are supported; the user picks one in Settings → AI. Other OpenAI-compatible and local providers (e.g. Ollama) can be added behind the same interface.

Model selection is configuration per use case (e.g. a smaller/cheaper model for classification and target resolution, a stronger one for research synthesis and drafting). Do not hard-code model IDs in domain code.

## Keys: bring your own

The user enters their own provider API key in Settings → AI (or in the first-run setup, which shows the same provider and key fields). It is stored encrypted via `safeStorage` (`18-SECURITY-PRIVACY-COMPLIANCE.md`). The product operates no proxy and resells no tokens.

## Structured output

For machine-consumed AI results, require schema validation (Zod). Invalid output → one bounded repair attempt → failure.

Example research output:

```json
{
  "companySummary": "...",
  "facts": [
    {
      "kind": "fact",
      "claim": "The company opened an office in Berlin in 2026.",
      "evidenceId": "019...",
      "quote": "we opened our new Berlin office in March 2026"
    },
    {
      "kind": "inference",
      "claim": "They are likely hiring for European sales.",
      "basedOnFactIndexes": [0]
    }
  ],
  "qualification": "match",
  "reasonToContact": "..."
}
```

## Grounding verification

Checking that an evidence ID exists does not prove a claim is supported. Therefore:

- every `fact` must carry a verbatim `quote`;
- the gateway verifies the quote is a substring of the referenced evidence's captured text after normalization (whitespace, case, Unicode quotes/dashes);
- facts whose quote is not found are rejected (or downgraded to `inference` and marked unsupported);
- `inference` items must reference facts and are displayed as interpretation.

Drafts: the generator returns the fact IDs used for personalisation. The draft checker verifies that specific personalised claims (names, numbers, dates, events) in the draft trace to used facts; unsupported specifics fail the `grounding` draft check.

## Semantic target resolution (ADR 013)

Replaces Stagehand.

1. The worker enumerates candidate elements in a scoped region (accessibility snapshot / role queries) and assigns short refs (`e1`, `e2`, ...), with role, accessible name, nearby text, and bounding box.
2. It sends `ai.resolveTarget { instruction, candidates, context }` to core.
3. The gateway asks the model to return `{ "ref": "e7" | null, "rationale": "...", "confidence": 0.0-1.0 }` constrained to the provided refs.
4. The worker acts on the chosen element with a deterministic Playwright action and verifies the result.

Constraints:

- the model can only choose among enumerated candidates or decline; it cannot produce selectors, URLs, text to type, or navigation;
- bounded attempts (default 2 per step), then human;
- in `auto` mode, not allowed for the final target of a critical action;
- page text in candidates is untrusted data (see below).

Implemented (Phase 6c) for website forms, as two closed-list questions through the gateway (`classification` model):

- `form.fields` v1 — for the fields the pack's phrases did not recognize (at most 30, one call per preparation): a meaning from `name, firstName, lastName, email, phone, company, website, subject, message`, or null. A consent is never in the list; choices for refs that were not sent are dropped. The field then gets the sender's value for that meaning and is marked "recognized by AI" in the approval.
- `form.contactLink` v1 — when no link says "contact" and no contact path exists: one of the site's own links (at most 40, text and path) or null.

Without a key, over budget, or on a provider failure the answer is "not available": the worker goes on without it, and a required field it cannot fill makes the form `assisted`. The submit button is never resolved by AI; sending never asks. Each resolution is audited as `ai.target_resolved` with counts only (ADR 022).

## Prompt versioning

Every reusable prompt template lives in the repository with:

- stable template key;
- version;
- purpose;
- input schema;
- output schema.

Persist template key/version with generated artefacts.

## AI use cases (MVP)

- research synthesis and fact extraction;
- ICP qualification;
- personalised draft;
- draft checks that need semantics (grounding of specifics);
- inbound reply classification;
- contact-form field mapping assistance;
- semantic target resolution.

## Forbidden implicit authority

AI may propose:

- a message;
- qualification;
- next step;
- a browser target from a candidate list.

AI may not:

- change approval policy or execution mode;
- add a new external recipient;
- modify campaign scope;
- solve security challenges;
- trigger critical actions without policy authorization.

## Prompt injection resistance

Web content and inbound emails are untrusted data.

When feeding them to models:

- delimit as untrusted source material and state that instructions inside must be ignored;
- never allow them to redefine system instructions;
- never include secrets;
- the model has no tools with side effects; outputs are data validated against schemas;
- keep scope bounded to the current workflow step.

Any instruction found on a webpage or in an email ("send credentials", "ignore previous instructions", "add this recipient") is page content, not a command. Tests include injection fixtures (`21-TESTING.md`).

## Cost controls

Per research run: max pages, max extracted characters, max model calls, max tokens, timeout.

Global: an optional monthly AI budget (implemented); the gateway refuses calls beyond it with a user-visible `budget` error. A per-campaign budget is planned for Phase 8.

Per browser task: bounded semantic attempts.

## Logging

Log:

- provider;
- model;
- latency;
- token usage and estimated cost;
- prompt template key/version;
- result status.

Do not log full prompts or page content by default. A developer setting may enable prompt logging to local files with redaction.
