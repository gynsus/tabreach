# 16 — Research Engine

## Goal

Produce useful outreach context from public/authorized sources while preserving evidence with verifiable quotes.

## Implementation status (Phase 4b, 2026-09-29)

- Static fetching only (`packages/core/src/research`): the company website, then up to 5 likely pages it links to on the same site (about, team, careers, news, services, contact — English and Russian), at most 6 pages. Browser rendering for JavaScript-only sites: Phase 5d, below.
- Redirects are followed one hop at a time, each checked like the first request: same site, `robots.txt`, and a public address — IP literals and host names resolving to loopback, private, link-local, carrier-grade NAT or multicast addresses are refused (audit 4.5). A `robots.txt` answering 5xx allows nothing; a failed request for it is asked again next time.
- `robots.txt` honoured for the user agent `TabReachResearch/0.1 (+local research tool; respects robots.txt)`; one request per second per host; 20 s and 2 MB per page; redirects off the site are refused.
- Extraction: Readability over linkedom. Scripts, styles and hidden elements (`hidden`, `aria-hidden`, `display:none`, `visibility:hidden`) are removed before extraction — hidden text is not evidence and is where injected prompts hide.
- Evidence is stored once per content hash and linked to runs. Synthesis: `research.synthesize` v4 since 8d-6, see "Campaign context" below (research model): the list and length limits are stated in the prompt (strict provider schemas drop them); summary, claims and reasons are written in the interface language as plain prose, while quotes stay verbatim in the page language. A fact's page ref is read from `E2`, `E2 <url>` or the page URL. A fact is kept as a fact only if its quote is found in its page's text after normalization and is at least 12 characters; otherwise it is stored as unverified and never used. Inferences need at least one verified fact.
- A website stored without a scheme (`njsoft.dev`) is researched over `https://`. A run whose job is gone is not waited for: it is failed (`research.failed`) and the message is written from older facts or none. Research started by a campaign is recorded as TabReach's action, not the user's. A run whose job gives up (last attempt or a permanent error) is failed with the reason; on start, runs without a live job are failed (`research.failed`).
- Live check with `deepseek/deepseek-v4.1-flash` via OpenRouter (2026-09-29, njsoft.dev, 6 pages): about 6.7k input and 4–5k output tokens (1–3k of them reasoning), 35–70 s, about $0.003 per run; 20 of 20 quotes verified on every run after v2.
- Not yet: sitemap.

## Implementation status (Phase 5d, 2026-09-29)

- A page whose static fetch yields less than 200 characters of readable text is rendered by the worker (`task.render`, RenderPageForResearch) in the research profile, headless, and read with the same extraction; evidence records `extractor: rendered-readability`, and links for the likely pages come from the rendered page. Only pages the static fetch already allowed (robots.txt, same site, public address) are rendered. See ADR 027 for the request guard.
- No worker, the app paused, the research profile in the person's hands, a challenge, or a page trying to leave the site: the page keeps its static text (or is skipped).
- Audit 5.5: every request of a rendered page is made by the worker with the connection pinned to the checked address, redirects are followed hop by hop by the worker (Chrome would follow a 3xx without asking again), and no cookies go out or are kept; the static fetcher's connections are pinned the same way (`pinnedHttp`), so DNS rebinding cannot point research at the user's network. IPv4-mapped, IPv4-compatible, NAT64 and 6to4 IPv6 forms are judged by the IPv4 address they carry.

## Campaign context (Phase 8d-6, 2026-10-11)

A campaign has a goal, an ICP (`icp`, who fits and who does not) and what research should look for (`researchInstructions`), plus how long research stays fresh (`researchMaxAgeDays`, default 30). These settings are the **context**.

- A run records its context: `criteria` (the ICP), `goal`, `instructions`, the campaign that asked, and `context_hash`. The hash is a SHA-256 of the three texts; it is null when all three are empty (migration 21; older runs count as the empty context).
- `research.synthesize` v4 gets the goal and what to look for next to the criteria. It prefers facts that matter for the goal and explains the reason to contact in terms of it. An exclusion in the criteria that the pages confirm makes the company `not_match`.
- `CampaignResearch.need(company, context)` is shared by AI messages, research conditions and "Research companies":
  - a fresh completed run with the same hash is used;
  - one still pending or running is waited for, polled every 20 s, however long it waits in the queue (a second run for the same context would pay twice — audit 8d.5); its job is bounded by its own attempts and a 6-hour age, and a run whose job is gone is failed first;
  - one that failed less than a day ago is not retried;
  - otherwise a new run is started with the context.

  A different goal, ICP or instructions means a new run; facts already captured are reused through the evidence hash.
- **AI messages** (`draft.write` v3 also gets the goal) use the facts of the context's run. Without one — no website, no key, or a recent failure — they fall back to an older run with that context, then to the company's latest facts, then to none.
- **Condition field `research.qualification`** (`eq`, `neq`, `exists`, `not_exists`; values `match`, `possible_match`, `not_match`, `insufficient_data`):
  - the condition step waits for the context's research;
  - without research the value is empty, so `eq match` does not hold; the stop records why (`rule: research.noWebsite`, `ai.no_key`, `research.failed`…);
  - launch needs an AI key and a non-empty ICP, and refuses `contains` (`campaign.qualificationOp`: "contains match" would also hold for `possible_match` and `not_match`); the editor does not offer it for this field;
  - `neq` holds when there is no research (the value is empty): use `eq` to let only rated companies through;
  - a dry run uses only research that already exists.
- **"Research companies"** (People section, `campaigns.research`, FR-RES-001) asks `need` for every company of the campaign's people who are still in it, using the launched version's context. It reports companies, people without a company, fresh, queued, without a website and failed recently. Research jobs run two at a time.
- The People list shows each person's company qualification under the context of their version; nothing is started for it.

## Research about a person (Phase 8d-10)

Contact-level research reads only the person's **company's own site**, with the same fetcher, the same rules (robots.txt, same site, public addresses, rendering) and the same limit of six pages. LinkedIn, search engines and other sites are not read.
- A run has `contact_id` (migration 24) and needs the person's first and last name; parts of the full name are used when the fields are empty. Company research lists and lookups leave person runs out.
- Only pages that name the person go to the model. "Naming" means first and last name together, in either order, with a middle name or patronymic allowed between them; accents and case are ignored, and a first name alone is not enough. The other pages are unlinked from the run.
- With no such page the run fails `research.personNotFound` and no AI call is made.
- `research.person` v1 writes a short summary and up to ten facts about this person only, each with a quote that is verified like a company fact. Inferences and qualification do not apply. Known limit: the check proves the quote is on a page that names the person, not that the quote is about them — on a team page a quote about a colleague would pass; the prompt forbids it, and the approval shows each fact with its source.
- Started from the contact page ("Research this person"), or by a campaign with **Also research each person** (`researchContacts`).
  - In such a campaign, AI messages wait for the person's research with the campaign context, as they do for the company's, and get its facts after the company's (`draft.write` v4).
  - "Research companies" also queues people and reports them.
  - Cost: one more AI call per person.

## Evidence with the quote highlighted (Phase 8d-7, FR-RES-005)

"Show in source", next to a verified fact on the company page and in an approval, opens the page text as captured. It shows the URL, the capture time, the title, and whether the text was read statically or after rendering, and scrolls to the quote, which is highlighted. `research.factSource` places the quote with the same normalization as verification (case, whitespace, typographic quotes and dashes), applied character by character so the highlight covers the original text. A text longer than 60 000 characters is cut to the part around the quote, with the number of characters left out before and after. When retention has removed the page text, the source and the verified quote are still shown.

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
