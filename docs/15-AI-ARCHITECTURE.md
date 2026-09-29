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
- Settings (`ai`): provider, model per use case (defaults: `claude-haiku-4-5-20251001` for classification, `claude-sonnet-5` for research and drafting), prices per model entered by the user, monthly budget. The key is a `SecretStore` secret (`ai_api_key`).
- `ai_calls` records template key/version, model, status, tokens, estimated cost and latency — never prompts or content. Cost and the budget work only for models with a price set; token counts are always shown.
- First use case: reply labels (`reply.classify` v1) — interested / not interested / opt-out / out-of-office / other. An opt-out adds the sender to the do-not-contact list. Without a key, replies are not sent anywhere.

## Provider abstraction

Provider-neutral interface for:

- structured generation (schema-validated JSON);
- text generation;
- classification;
- optional vision (screenshot input for target resolution, off by default).

Anthropic is the primary initial provider. The interface must allow OpenAI-compatible and local providers (e.g. Ollama) later.

Model selection is configuration per use case (e.g. a smaller/cheaper model for classification and target resolution, a stronger one for research synthesis and drafting). Do not hard-code model IDs in domain code.

## Keys: bring your own

The user enters their own provider API key in the setup wizard. It is stored encrypted via `safeStorage` (`18-SECURITY-PRIVACY-COMPLIANCE.md`). The product operates no proxy and resells no tokens.

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

Per campaign: optional monthly AI budget; the gateway refuses calls beyond it and raises a user-visible error.

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
