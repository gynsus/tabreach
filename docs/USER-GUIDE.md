# TabReach — User Guide

This guide is for people using TabReach, not for developers. It describes the app as of Phase 8e.

## What you need

- A Mac with macOS 13 Ventura or later (Apple Silicon or Intel) and Google Chrome installed.
- An API key from an AI provider if you want research and AI-written messages: Anthropic, OpenAI or OpenRouter. Templates work without one.
- An email account to send from: Gmail (through your own Google OAuth client) or any mailbox with IMAP and SMTP.

Everything runs on your Mac. Your data lives in `~/Library/Application Support/TabReach` and logs in `~/Library/Logs/TabReach`. Nothing is sent anywhere except to the sites you work with, your mail server and your AI provider.

## Install, update and remove

1. Download the DMG for your Mac: `TabReach-<version>-arm64.dmg` for Apple Silicon (M1 and later), `TabReach-<version>-x64.dmg` for Intel. Apple menu → About This Mac shows which one you have.
2. Open the DMG and drag **TabReach** onto **Applications**.
3. Start TabReach from Applications. A release build is signed and notarized by Apple, so macOS opens it after the usual "downloaded from the internet" question. A test build without Apple's signature is refused the first time: open System Settings → Privacy & Security and press **Open Anyway** next to TabReach.

   If a test build ran on this Mac before, the first start of a release build asks for your Mac password to let TabReach use "TabReach Safe Storage" in the Keychain: the stored keys belong to the app, and macOS checks that the new signature may read them. Enter the password and press **Always Allow**. Until you answer, TabReach waits.

**Update:** quit TabReach, install the new version the same way and replace the old app. Your data stays where it is; before changing it, the new version makes a backup (see Data below).

**Remove:** quit TabReach and move it from Applications to the Bin. Your data is not deleted with the app. To remove it too, delete `~/Library/Application Support/TabReach` and `~/Library/Logs/TabReach`. The browser profiles are in the first folder, so this also signs you out of every site you used in them. The keys and passwords TabReach stored are in the Keychain under "TabReach Safe Storage".

## First run

A short setup opens on first launch. Each step can be skipped and done later in Settings:

1. Language — English or Russian.
2. Chrome — TabReach checks that Google Chrome opens.
3. AI key — stored encrypted in the macOS Keychain; it is never shown again.
4. Email account — see below.
5. First browser profile — a separate Chrome profile that TabReach manages; you sign in to sites in it yourself.

## Email accounts (Settings → Email)

- **IMAP / SMTP.** Enter the address; known providers fill in the servers. Use an app password where the provider requires one (iCloud, Yandex, Mail.ru, Gmail with 2-step verification).
- **Outlook / Microsoft 365.** Microsoft no longer accepts passwords from mail apps, so TabReach signs in with Microsoft through an app you register once in Microsoft Entra (about 10 minutes):
  1. Sign in at entra.microsoft.com with an account that has a directory — a Microsoft 365 work account or a free Azure account. A personal Outlook.com account on its own can no longer register apps.
  2. App registrations → New registration. For an Outlook.com or Hotmail mailbox choose "Any Entra ID tenant + personal Microsoft accounts"; for your own company's mailbox "This organizational directory only" is enough.
  3. Redirect URI: platform "Public client/native (mobile & desktop)", value `http://localhost`.
  4. API permissions → Microsoft Graph → Delegated: `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`.
  5. In TabReach (Settings → Email → Connect Outlook / Microsoft 365) enter the address and the Application (client) ID; for a single-directory app also the Directory (tenant) ID. Sign in with the same address in the browser.

  In Microsoft 365, IMAP and Authenticated SMTP must be allowed for the mailbox (an administrator may have turned them off). When Microsoft asks you to sign in again — after a password change or a new security prompt — the account shows "Needs signing in again"; press **Sign in with Microsoft**. Disconnecting deletes TabReach's token; to remove the app's access on Microsoft's side too, use myaccount.microsoft.com (work) or account.live.com/consent/Manage (personal).
- **Gmail API.** The wizard explains how to create your own OAuth client in Google Cloud and checks the client ID before opening the browser. While your Google app is in Testing status, Google expires the sign-in after about 7 days; set it to In production to avoid that. An app used only by you may qualify for Google's personal-use exception from verification; you will still see Google's unverified-app warning when you sign in. A Google Workspace account can use an Internal app instead, without the warning.

TabReach reads the inbox to notice replies and bounces. It only looks at mail from people you contacted, from the moment the account was connected.

Each account sends at most 50 emails a day, 60 seconds apart, unless you change its limits.

## AI (Settings → AI)

- Choose the provider (Anthropic, OpenRouter or OpenAI) and paste your key; **Test key** makes one tiny call. Each provider keeps its own key, so switching back does not ask for it again.
- Models are suggested per provider; you can set one each for reply labels, research and drafts.
- **Prices** (USD per million tokens) let TabReach estimate cost. OpenRouter reports the cost of every call by itself, so prices are optional there. Without a price, tokens are counted but cost is unknown — and a budget cannot be enforced.
- **Monthly budget** — once the estimated cost of the month reaches it, no more AI calls are made; AI steps and research wait until you raise it or the month ends. The usage of the month is shown below. A campaign can have a smaller budget of its own (Campaigns → Goal and audience).

## Contacts and companies

- Import a CSV (Contacts → Import). You see a preview and a report of new, updated, skipped and invalid rows; importing the same file again changes nothing.
- Export contacts as CSV at any time.
- **Do not contact** — an address, a whole domain, a company or a profile URL. It is checked right before every send, including replies you write yourself.
- Research (on a company page, needs an AI key) reads the company's website and keeps facts only with a quote that really appears on the page, with its link. **Show in source** next to a fact opens the page text as it was read, with the quote highlighted.
- **Research this person** (on a contact page) looks for the person on their company's own site — team, news, blog — and keeps only facts about them with verified quotes. LinkedIn and other sites are not read. A campaign can do this for everyone (**Also research each person** in Goal and audience); its AI messages then use what the site says about the recipient.

## Campaigns

A campaign page has five tabs:
- **Overview** — before launch, what is still to set up; afterwards, how many messages went out, how many people replied, who is in progress, and the history.
- **Audience** — goal, who fits, and research.
- **Sequence** — the steps, each marked with the earliest day it can happen.
- **People** — who is in the campaign.
- **Settings** — mailbox, sending hours and approval.

If a launch finds a problem, the tab with the problem opens, and every tab that has one is marked.

**Build with AI** (Campaigns) sets a campaign up from your own words, and needs an AI key. You describe whom you want to reach and why, and answer the few questions it still has. You then get a plan: the goal, who fits, what research looks for, the steps by day and the safety settings. The plan also lists what it does differently from what you asked (for example, LinkedIn is always assisted), what it assumed, and what still needs fixing before launch. **Create draft** saves the plan as an ordinary draft and opens it; nothing is sent until you launch it and add people.

1. Create a campaign and add steps (Sequence). A step sends one message on a channel — email, the company's website contact form, or LinkedIn — written from a template (with `{{firstName}}`, `{{companyName|fallback}}` and so on) or by AI from the company's research. Each step has a delay before it. A condition step can stop a person or skip the next step. A **task** step is something you do yourself, such as a call: when a person reaches it, it appears in **Tasks** with their details, and their sequence goes on when you press **Done** or **Skip** (or **Stop the person**). A later email step can be sent **as a reply in the same thread**: it gets the subject "Re: …" of the first email and appears in the same conversation in the recipient's mail.
2. Fill in **Audience** (optional, but it makes research and AI messages much better):
   - **Goal** — what the campaign should achieve; AI messages aim at it.
   - **Who fits (ICP)** — location, company type, signals, and who to leave out. Research rates each company: fits, may fit, does not fit, or not enough data. The People list shows the rating.
   - **What research looks for** — the facts you need most from the company's site.
   - **Research is fresh for** — after that many days a company is researched again.
   - **AI budget for this campaign** — the most its AI messages and research may cost in total. When it is reached nobody is stopped: AI steps wait ("Waiting for AI budget") until you raise it. What the campaign spent so far is shown below the field.

   A **condition step** with "Research: fits the ICP is Match" lets only fitting companies through; the person waits until the company's research is done. **Research companies** in People researches every company of the campaign at once (it uses your AI key).
3. In **Settings**, choose the sending hours (or keep the default from Settings) and the approval mode:
   - **Approve each** (default) — every message waits for you;
   - **Approve campaign** — after a sample you approved by hand, AI messages that pass every check go on their own.
4. **Dry run** — pick a contact to see the first message, where and when it would go, or why it would not. Nothing is stored or sent.
5. **Launch**, then **Add contacts**.

Good to know:

- Messages go only within the sending hours, in the recipient's time zone. The People list says "Waiting for sending hours" with the hours and zone when that is what a person waits for.
- A reply stops the person's sequence. Limits per person and per company (Settings → Policy) keep you polite.
- Editing a running campaign and launching again creates a new version. People already in the campaign stay on their version until you press **Move to vN** in the People section. A message you already approved still goes as approved.
- A campaign that was never launched can be deleted; a launched one can only be archived. **Show archived** brings archived campaigns back into view, and any campaign can be copied.
- **Export CSV** in People saves one row per person with status, step, sends and replies, for your CRM.
- **Who presses Send** — on website-form and LinkedIn steps: TabReach after your approval (`auto`), you in the browser window (`assisted`, the default), or you do it all with the text at hand (`manual`). A form with a CAPTCHA or a field TabReach cannot fill is always sent by you.
- When someone replies, no campaign writes to them again — nor, for a strong company match, to their colleagues — until you press **Allow campaigns to write again** on the contact page.

## Today

TabReach opens on **Today**: unread replies (interested ones first), messages waiting for your review, open tasks and anything under Needs attention, then each running campaign with how many messages it sent, how many people replied and how many are still in progress. Each number opens its screen.

The line at the foot of the menu says whether TabReach is fine. It reads "Everything is working", says what needs you, names a broken part, or shows that outreach is paused. Click it for **Pause all** and **Emergency stop**, or open the full **Status** page from there.

## Review

The queue (called Approvals before) shows exactly what will go out, to whom and when, with the checks and the research facts used. Keyboard: **A** approve, **E** edit, **S** skip, **R** reject (press twice), **J / K** next and previous.

**Check claims with AI** reads the message against the research facts, the contact's details and your instructions, and lists the statements nothing there supports, each with a suggested rewording. It runs only when you press it (one AI call, counted in the campaign's AI budget) and never changes the message: press **E** to use a suggestion. It does not replace the automatic checks, and finding nothing does not prove the message right, so still read it.

## Inbox

Replies are matched to the person and campaign and labelled by AI (interested, not interested, out of office, opt-out). **Reply** writes back in the same thread from the same mailbox; **Suggest a reply** drafts the text from the conversation and your notes, and you edit it before sending. A reply is checked against Do not contact and is refused while everything is paused.

## Browser, website forms and LinkedIn

- **Browser** shows the profiles TabReach manages. You can watch any window, **take control** and **return control**. TabReach stops and hands you the window at any CAPTCHA, two-factor prompt or page it does not recognise; it never tries to get around them.
- **Website forms** (Settings → Website forms): pick a profile and your sender details. The form is found and filled before approval, and the approval shows a picture of exactly what goes in.
- **LinkedIn** is off until you accept the risk notice in Settings → LinkedIn. It runs **assisted** by default: TabReach opens the profile, checks it is the right person and puts the text in place, and you press Send. In **manual** mode it opens the profile (or the conversation) and shows the text with a **Copy** button; you send it yourself and then tell TabReach whether it went out. **Auto** works only after you allow it in Settings → LinkedIn, separately for invitations and messages.
- LinkedIn limits default to 15 invitations a day, 80 a week and 30 messages a day, 90 seconds apart. You can lower them freely; raising them above these defaults needs you to accept the higher risk. These are TabReach's cautious defaults, not LinkedIn's rules, and no guarantee against restrictions.

## Pause all and Emergency stop

**Pause all** (the status line at the foot of the menu, or the Status page) stops every new send and browser action; reading replies goes on. **Emergency stop** also closes the browser at once. Nothing is lost: when you resume, waiting work continues.

**Keep the Mac awake while campaigns are active** (Status) stops the Mac from sleeping while something is scheduled. Without it, work due while the Mac slept is moved to the next sending window after it wakes, never sent in a burst.

## Activity and Status

- **Activity** lists everything TabReach did and you decided — added to a campaign, written, approved, sent, replied, stopped — and each contact, company and campaign page has its own timeline.
- **Status** (from the status line at the foot of the menu) shows whether the app's parts, the database and Chrome are healthy, what needs your attention (failed work, unconfirmed sends), and per adapter pack how often pages were not recognised — a jump there usually means the site changed.

## Unconfirmed sends

If TabReach cannot tell whether a message went out (for example, the connection dropped while sending), it never sends it again by itself. It appears under **Status → Needs attention → Unconfirmed sends**: check your Sent folder or the site, then mark it **Sent** or **Not sent**. Only "Not sent" allows another attempt.

## Data (Settings → Data)

- **Backups** are made before every update of the data and whenever you press **Back up now**. Restoring one restarts the app paused, so you can look before anything is sent. Messages already sent are of course not undone, and TabReach keeps knowing they were sent.
- **Portable export** — a copy of the data without passwords and keys, to move to another Mac.
- **Retention** — how long screenshots, browser diagnostics, message texts, research page text and old logs are kept.
- **Diagnostics bundle** (Status) — a zip for a bug report without passwords, keys, cookies, message texts, names, addresses or page links. You choose where to save it and whom to send it to.

## Privacy

TabReach has no server and no account. It talks only to the sites you open with it, your email provider, your AI provider, and Google if you use the Gmail API. Browser profiles stay on your Mac and are never included in logs or diagnostics.
