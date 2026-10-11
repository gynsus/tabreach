# ADR 032 — Microsoft sign-in for IMAP/SMTP (XOAUTH2)

**Status:** Accepted (2026-10-11, Phase 8d). Amends ADR 016.

## Context

ADR 016 lists IMAP/SMTP with "OAuth2/XOAUTH2 where required, otherwise app passwords". Until now only passwords were implemented. That is not enough for Microsoft:

- Outlook.com (Hotmail, Live) no longer accepts passwords from mail apps; IMAP and SMTP need OAuth (modern auth).
- Microsoft 365 is retiring basic authentication for SMTP AUTH as well. IMAP basic auth is already gone.

Microsoft's mail servers take a token through SASL XOAUTH2. The token comes from the Microsoft identity platform: authorization code flow with PKCE for a public client (a desktop app has no secret), scopes `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send` and `offline_access`.

Facts that shape the design:

- Every app needs a registration in Microsoft Entra. Such a registration can no longer be created outside a directory, so a person with only an Outlook.com account first needs a directory, for example a free Azure account.
- For `http` loopback redirects, Entra's portal accepts only `http://localhost`, and then ignores the port. `http://127.0.0.1` can only be added by editing the app manifest, and `[::1]` is not supported.
- Microsoft rotates refresh tokens: a refresh usually returns a new refresh token, and old ones may stop working.
- Microsoft has no simple endpoint to revoke a refresh token.

Gmail already has the Gmail API path (ADR 016). Gmail over IMAP with XOAUTH2 needs the `https://mail.google.com/` scope: a restricted scope with the same user-owned client setup and no gain. Other providers that offer XOAUTH2, such as Yahoo or AOL, require a developer registration with them and are rare among the target users.

## Decision

- **Microsoft only.** The XOAUTH2 path is for Outlook.com and Microsoft 365 mailboxes. Gmail keeps the Gmail API, or an app password over IMAP. Other providers keep app passwords.
- **The user's own Entra app registration**, as with option A/B in ADR 016:
  - The wizard (Settings → Email → Connect Outlook / Microsoft 365) explains how to register the app: a public client, redirect URI `http://localhost` under "Mobile and desktop applications", the delegated permissions `IMAP.AccessAsUser.All`, `SMTP.Send` and `offline_access`, and the mailbox prerequisites.
  - The user enters the address, the Application (client) ID and, optionally, the directory ID or domain. The default directory is `common`, which accepts work, school and personal accounts.
  - A publisher-owned app (like ADR 016 option C) can be added later without changing the code path; only the source of the client ID would change.
- **Same account kind.** The account stays `provider = imap_smtp`; its metadata gets `oauth: { provider: 'microsoft', clientId, tenant }`. The servers are fixed: `outlook.office365.com:993` TLS and `smtp.office365.com:587` STARTTLS. The SMTP and IMAP username is the address. Sending, Sent reconciliation, reply polling and bounces are unchanged: they get an access token in place of a password (`MailSettings.accessToken`). nodemailer sends `AUTH XOAUTH2`; imapflow sends `AUTHENTICATE XOAUTH2`, or `OAUTHBEARER` where offered.
- **Connecting** (`accounts.connectMicrosoft`):
  1. core builds the authorize URL with PKCE S256, `state`, `login_hint` set to the address and `prompt=select_account`;
  2. main runs the loopback (below);
  3. core checks `state`, exchanges the code without a client secret, and requires a refresh token and both mail scopes;
  4. core tests SMTP and IMAP with the token.

  A server that refuses the token means another account was chosen on the page, or IMAP or SMTP AUTH is off for the mailbox (`account.oauthRefused`). Only after both tests pass is the refresh token stored, encrypted (`oauth_refresh_token`). Signing in again for an address already connected this way renews the same account. An address connected with a password is not taken over.
- **Tokens:**
  - Access tokens live only in memory and are renewed when less than 5 minutes remain, so a token cannot run out during a send. Concurrent callers share one renewal per account.
  - A new refresh token returned on renewal replaces the stored one: the new secret is written, the account row is switched only if it still points to the old secret, and the old secret is deleted. If the account was renewed or disconnected in the meantime, the new secret is dropped instead.
  - When the grant is gone (`invalid_grant`, `interaction_required`, `consent_required`), the account goes to `auth_required` and the UI offers "Sign in with Microsoft" again. The same happens when a server refuses the token. The cached token is dropped whenever an account goes to `auth_required`.
- **Loopback redirect.** Main's allowlist becomes a map from authorization host to redirect host name:
  - `accounts.google.com` → `127.0.0.1`;
  - `login.microsoftonline.com` → `localhost`.

  The listener stays bound to `127.0.0.1` only, single-use, on a random port, with `state` checked. Browsers and the OS try both loopback addresses for `localhost`, so they reach it. This keeps the rule in CLAUDE.md §3.11, and the user never edits an app manifest.
- **Disconnect** deletes the stored refresh token. Microsoft offers no simple revocation, so the user removes the app's access at myaccount.microsoft.com (work accounts) or account.live.com/consent/Manage (personal accounts); the user guide says so.
- **No secrets in logs.** Only error codes are logged (`microsoft.oauth_refused`, `microsoft.token_exchange_failed`, `microsoft.token_refresh_failed` with `kind`). Microsoft's error descriptions can name the account and are never kept.

## Alternatives

- **Device code flow:** the user types a code at microsoft.com/devicelogin. It needs no redirect URI, but it is a weaker UX, and Conditional Access often blocks it in organisations. Rejected for now.
- **A redirect host of `127.0.0.1` registered through the manifest:** this follows RFC 8252 more closely, but asks every user to edit JSON in the Entra portal. Rejected. The listener is on `127.0.0.1` either way.
- **Listening on `::1` as well:** a second socket for no gain, because clients fall back to IPv4. Rejected.
- **Microsoft Graph `sendMail` and mailbox APIs** instead of IMAP/SMTP: a bigger adapter, different reconciliation and other scopes. It stays the later option named in docs/14.
- **Using another product's public client ID** (for example a mail client's) to skip the registration: that is impersonation. Rejected.

## Consequences

- Outlook.com and Microsoft 365 mailboxes can be connected without app passwords; the rest of the email channel is unchanged.
- Setup takes about 10 minutes and needs an Entra directory. The wizard and the user guide must stay accurate as Microsoft's portal changes.
- An organisation may block user consent or turn off SMTP AUTH; the error tells the user what to check, and an administrator has to allow it.
- Refresh-token rotation writes a new secret on each renewal, roughly hourly while the account is in use. That is a small write to the secrets table.
- Migration impact: none. The schema is unchanged; new data lives in account metadata. Existing password accounts are untouched, and the DTO adds `signIn` and `oauthClient`.
