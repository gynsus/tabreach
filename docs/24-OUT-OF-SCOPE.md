# 24 — Out of Scope for MVP

The following must not be implemented merely because they seem adjacent.

## Product

- cloud/SaaS control plane, server sync, remote access (not a product direction at all);
- multi-user teams;
- RBAC;
- billing, subscriptions, licensing/activation (monetization, if any, will not require architecture — e.g. donations or paid support);
- agency white-label;
- full CRM replacement;
- lead marketplace;
- native mobile app;
- complex analytics dashboard;
- visual no-code automation builder.

## Browser infrastructure

- custom Chromium fork;
- bundled/downloaded browser (the user's installed Chrome is used);
- Chrome extension (replaced by the injected overlay — ADR 014);
- recorder / teach mode (post-MVP);
- stealth browser;
- fingerprint spoofing;
- CAPTCHA solving;
- residential proxy marketplace;
- proxy rotation intended to bypass platform controls;
- cloud browser fleet;
- many simultaneous browser sessions (MVP: one task per profile, few profiles);
- remote adapter-pack update feed (post-MVP; packs are bundled in MVP).

## Channels

- WhatsApp;
- SMS;
- voice dialer;
- Telegram;
- Instagram;
- Facebook;
- X;
- Reddit;
- every job board/marketplace;
- Microsoft Graph email adapter (post-MVP; IMAP/SMTP covers Microsoft mailboxes meanwhile where permitted);
- full LinkedIn inbox sync (MVP only checks threads before follow-ups).

Additional adapters require a separate decision after MVP.

## AI

- unrestricted autonomous web agent;
- general-purpose browser agents (Stagehand-style `act`) — replaced by bounded target resolution (ADR 013);
- self-modifying production workflows;
- autonomous credential entry;
- autonomous response sending without configured campaign policy;
- a vendor-operated AI proxy (users bring their own key);
- training/fine-tuning own foundation model.

## Data

- Apollo-like global lead database;
- large-scale scraping infrastructure;
- contact email discovery/enrichment marketplace.

## Platform

- Windows and Linux builds (post-MVP; the stack keeps Windows feasible);
- Docker, containers, Kubernetes;
- separate backend services or message brokers;
- multi-region anything.

## Rule

If an out-of-scope feature becomes necessary to complete an MVP acceptance criterion, create an ADR explaining why the criterion cannot be met with the current design before implementing it.
