# 16 — Research Engine

## Goal

Produce useful outreach context from public/authorized sources while preserving evidence with verifiable quotes.

## Implementation status (Phase 4b, 2026-09-29)

- Static fetching only (`packages/core/src/research`): the company website, then up to 5 likely pages it links to on the same site (about, team, careers, news, services, contact — English and Russian), at most 6 pages. Browser rendering for JS-only sites comes with the worker (Phase 5).
- `robots.txt` honoured for the user agent `TabReachResearch/0.1 (+local research tool; respects robots.txt)`; one request per second per host; 20 s and 2 MB per page; redirects off the site are refused.
- Extraction: Readability over linkedom. Scripts, styles and hidden elements (`hidden`, `aria-hidden`, `display:none`, `visibility:hidden`) are removed before extraction — hidden text is not evidence and is where injected prompts hide.
- Evidence is stored once per content hash and linked to runs. Synthesis: `research.synthesize` v1 (research model). A fact is kept as a fact only if its quote is found in its page's text after normalization and is at least 12 characters; otherwise it is stored as unverified and never used. Inferences need at least one verified fact.
- Not yet: sitemap, research freshness per campaign, contact-level research.

## MVP input

Research begins from existing prospect data:

- company name;
- website/domain;
- contact name/title if known;
- explicitly supplied URLs.

Lead discovery is out of scope.

## Collection strategy

Runs in core, except rendering.

Priority:

1. static HTTP fetch in core (`fetch`), HTML → main-content extraction (Readability-style) → normalized text;
2. browser-rendered fetch when the static result is empty/JS-dependent: `RenderPageForResearch` task in the worker using the **research profile** (never a channel identity profile);
3. bounded navigation to likely high-value pages found via links and sitemap.

Likely pages:

- home;
- about;
- services/products;
- team;
- careers/jobs;
- news/blog;
- contact.

Respect configured limits (pages, characters, time).

## Robots and site restrictions

- honour `robots.txt` for the app's fetcher user agent;
- identify with an honest user agent for static fetches;
- per-domain rate limit;
- do not attempt to bypass access controls; if a site requires authentication and the campaign has no authorized context, stop for that source.

## Evidence pipeline

```text
Fetch / Render
  |
  v
Extract main text + title
  |
  v
Normalize + hash (dedupe identical content across runs)
  |
  v
Evidence records
  |
  v
AI synthesis (structured output)
  |
  v
Quote verification (substring check against evidence text)
  |
  v
ResearchFacts (fact | inference) + evidence IDs
```

## Research result

Required sections:

- company summary;
- observed facts (each with evidence + verified quote);
- inferences (each referencing facts);
- likely relevance to campaign;
- reason-to-contact;
- qualification;
- missing information;
- evidence references.

## ICP qualification

Campaign defines criteria such as:

- location;
- company type;
- service/technology;
- size if known;
- hiring signal;
- market signal;
- exclusion criteria.

Return:

```text
match
possible_match
not_match
insufficient_data
```

with explanation referencing facts. Do not invent missing employee counts/revenue/etc. — absence is `insufficient_data`.

## Research refresh

Evidence ages.

Campaign can define a freshness threshold. Re-run creates a new `ResearchRun`; identical page content is linked by content hash rather than duplicated.

Old evidence remains available for audit until retention removes it.
