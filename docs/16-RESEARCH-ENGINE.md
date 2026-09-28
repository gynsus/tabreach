# 16 — Research Engine

## Goal

Produce useful outreach context from public/authorized sources while preserving evidence with verifiable quotes.

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
