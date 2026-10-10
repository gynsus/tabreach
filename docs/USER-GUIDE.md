# TabReach — User Guide

This guide is for people using TabReach, not for developers. It describes the app as of Phase 8d; the signed Mac installer comes with Phase 8e.

## What you need

- A Mac (Apple Silicon or Intel) and Google Chrome installed.
- An API key from an AI provider if you want research and AI-written messages: Anthropic, OpenAI or OpenRouter. Templates work without one.
- An email account to send from: Gmail (through your own Google OAuth client) or any mailbox with IMAP and SMTP.

Everything runs on your Mac. Your data lives in `~/Library/Application Support/TabReach` and logs in `~/Library/Logs/TabReach`. Nothing is sent anywhere except to the sites you work with, your mail server and your AI provider.

## First run

A short setup opens on first launch. Each step can be skipped and done later in Settings:

1. Language — English or Russian.
2. Chrome — TabReach checks that Google Chrome opens.
3. AI key — stored encrypted in the macOS Keychain; it is never shown again.
4. Email account — see below.
5. First browser profile — a separate Chrome profile that TabReach manages; you sign in to sites in it yourself.

## Email accounts (Settings → Email)

- **IMAP / SMTP.** Enter the address; known providers fill in the servers. Use an app password where the provider requires one (iCloud, Yandex, Mail.ru, Gmail with 2-step verification). Sign-in with OAuth for IMAP/SMTP (XOAUTH2) is not supported yet.
- **Gmail API.** The wizard explains how to create your own OAuth client in Google Cloud and checks the client ID before opening the browser. While your Google app is in Testing status, Google expires the sign-in after about 7 days; set it to In production to avoid that. An app used only by you may qualify for Google's personal-use exception from verification; you will still see Google's unverified-app warning when you sign in. A Google Workspace account can use an Internal app instead, without the warning.

TabReach reads the inbox to notice replies and bounces. It only looks at mail from people you contacted, from the moment the account was connected.

## Contacts and companies

- Import a CSV (Contacts → Import). You see a preview and a report of new, updated, skipped and invalid rows; importing the same file again changes nothing.
- Export contacts as CSV at any time.
- **Do not contact** — an address, a whole domain, a company or a profile URL. It is checked right before every send, including replies you write yourself.
- Research (on a company page, needs an AI key) reads the company's website and keeps facts only with a quote that really appears on the page, with its link.

## Campaigns

1. Create a campaign and add steps. A step sends one message on a channel — email, the company's website contact form, or LinkedIn — written from a template (with `{{firstName}}`, `{{companyName|fallback}}` and so on) or by AI from the company's research. Each step has a delay before it. A condition step can stop a person or skip the next step.
2. Choose the sending hours (or keep the default from Settings) and the approval mode:
   - **Approve each** (default) — every message waits for you;
   - **Approve campaign** — after a sample you approved by hand, AI messages that pass every check go on their own.
3. **Dry run** — pick a contact to see the first message, where and when it would go, or why it would not. Nothing is stored or sent.
4. **Launch**, then **Add contacts**.

Good to know:

- Messages go only within the sending hours, in the recipient's time zone. The People list says "Waiting for sending hours" with the hours and zone when that is what a person waits for.
- A reply stops the person's sequence. Limits per person and per company (Settings → Policy) keep you polite.
- Editing a running campaign and launching again creates a new version. People already in the campaign stay on their version until you press **Move to vN** in the People section. A message you already approved still goes as approved.
- A campaign that was never launched can be deleted; a launched one can only be archived. **Show archived** brings archived campaigns back into view, and any campaign can be copied.
- **Export CSV** in People saves one row per person with status, step, sends and replies, for your CRM.

## Approvals

The queue shows exactly what will go out, to whom and when, with the checks and the research facts used. Keyboard: **A** approve, **E** edit, **S** skip, **R** reject (press twice), **J / K** next and previous.

## Inbox

Replies are matched to the person and campaign and labelled by AI (interested, not interested, out of office, opt-out). **Reply** writes back in the same thread from the same mailbox; **Suggest a reply** drafts the text from the conversation and your notes, and you edit it before sending. A reply is checked against Do not contact and is refused while everything is paused.

## Browser, website forms and LinkedIn

- **Browser** shows the profiles TabReach manages. You can watch any window, **take control** and **return control**. TabReach stops and hands you the window at any CAPTCHA, two-factor prompt or page it does not recognise; it never tries to get around them.
- **Website forms** (Settings → Website forms): pick a profile and your sender details. The form is found and filled before approval, and the approval shows a picture of exactly what goes in.
- **LinkedIn** is off until you accept the risk notice in Settings → LinkedIn. It runs **assisted** by default: TabReach opens the profile and puts the text in place, and you press Send. Limits per day are conservative.

## Pause all and Emergency stop

**Pause all** (top bar) stops every new send and browser action; reading replies goes on. **Emergency stop** also closes the browser at once. Nothing is lost: when you resume, waiting work continues.

## Unconfirmed sends

If TabReach cannot tell whether a message went out (for example, the connection dropped while sending), it never sends it again by itself. It appears under **Status → Needs attention → Unconfirmed sends**: check your Sent folder or the site, then mark it **Sent** or **Not sent**. Only "Not sent" allows another attempt.

## Data (Settings → Data)

- **Backups** are made before every update of the data and whenever you press **Back up now**. Restoring one restarts the app paused, so you can look before anything is sent. Messages already sent are of course not undone, and TabReach keeps knowing they were sent.
- **Portable export** — a copy of the data without passwords and keys, to move to another Mac.
- **Retention** — how long screenshots, browser diagnostics, message texts, research page text and old logs are kept.
- **Diagnostics bundle** (Status) — a zip for a bug report without passwords, keys, cookies, message texts, names, addresses or page links. You choose where to save it and whom to send it to.

## Privacy

TabReach has no server and no account. It talks only to the sites you open with it, your email provider, your AI provider, and Google if you use the Gmail API. Browser profiles stay on your Mac and are never included in logs or diagnostics.
