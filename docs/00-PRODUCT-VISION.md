# 00 — Product Vision

## Problem

Outbound work is fragmented across:

- prospect lists;
- company research;
- website visits;
- social networks;
- email clients;
- contact forms;
- spreadsheets;
- CRMs;
- AI chat windows;
- manual follow-ups.

Existing tools usually solve one slice:

- email sequencing;
- LinkedIn automation;
- data enrichment;
- generic browser automation;
- AI research.

Most of them are cloud services that hold the user's prospect data, mailbox access and browser sessions on someone else's servers.

The product should unify these slices without pretending that every site is a stable API, and without taking the user's data or sessions off their machine.

## Product thesis

The browser is a universal connector for workflows that do not have a suitable official API, while normal APIs remain preferable where they are reliable and appropriate.

The system should:

1. know the prospect and campaign context;
2. research a company and retain evidence;
3. prepare personalised outreach;
4. select a permitted channel and execution mode;
5. execute through an API or a managed browser — automatically, or assisted by the user;
6. stop for human approval or security challenge where required;
7. verify the outcome;
8. monitor replies;
9. continue the sequence;
10. keep a complete action trail.

## Product identity

The product is not “a bot that clicks websites”.

TabReach is an **outreach browser**: a controlled browser runtime integrated with an outreach orchestration engine, running entirely on the user's own computer.

Conceptually:

```text
Prospect + Campaign + AI Context
              |
              v
        Action Intent
              |
      +-------+-------+
      |               |
   API Adapter    Browser Adapter
      |          (auto / assisted / manual)
      +-------+-------+
              |
        Verified Result
              |
          Timeline
```

## Core differentiators

### 1. Browser as a first-class runtime

Browser profiles, sessions, tabs, action logs, recovery and human takeover are domain-level concerns.

### 2. Deterministic automation with bounded AI assistance

Known paths use deterministic automation defined by adapter packs. AI helps locate targets when pages change, but chooses only from candidates the runtime enumerated.

### 3. Evidence-first AI

Personalisation must be based on captured evidence with verified quotes, not invented facts.

### 4. Human-in-the-loop as a feature

Human approval, assisted execution (the user presses the final button) and takeover are intentional product states, not failure modes.

### 5. Channel abstraction

Email, forms and social/browser actions share campaign semantics but use independent adapters.

### 6. Local-only trust model

The application, its database, browser sessions and profile data remain on the local machine. There is no vendor server in the data path. The user brings their own AI provider key and their own email OAuth client.

## Distribution

Initially built for the author's own use; designed from day one to be installable by other people as a self-contained macOS application (signed, notarized, no Docker, no manual service setup). Monetization, if any, is out of scope for architecture (for example donations or paid support) and must not introduce server dependencies.

## Long-term direction

Potential future product layers, all compatible with the local-only model:

- Windows support;
- more channel adapters;
- richer reply intelligence, including broader LinkedIn inbox reading;
- CRM integrations via webhooks/exports;
- signed out-of-band adapter-pack updates;
- recorder / teach mode for building adapter packs;
- local LLM providers.

These are directions, not MVP commitments. A cloud/SaaS control plane is explicitly not a direction.

## Success definition for MVP

The MVP succeeds when one user can install the app, create a campaign, import real prospects, obtain evidence-based research and personalised messages, approve actions, execute email or browser actions through persistent authenticated sessions, survive interruptions (including app restart and Mac sleep), and see verified outcomes and replies in one interface.
