# ADR 028 — The project is licensed under AGPL-3.0-only

**Status:** Accepted (2026-10-10, Phase 8)

## Context

The source is public, and signed builds will be published for anyone to install (Phase 8e). The repository had no license, which leaves every use outside GitHub's terms unclear: no one may lawfully modify or redistribute the code, and contributors have no terms to contribute under. The owner wants the code open, but does not want a closed fork — for example a hosted service built on it — to take the work without giving changes back.

## Decision

- The project is licensed under the GNU Affero General Public License, version 3 only (`AGPL-3.0-only`). The verbatim text is in `LICENSE`; every `package.json` declares the SPDX identifier.
- Every dependency shipped in the app must have a license compatible with AGPL-3.0: MIT, MIT-0, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD (ADR 019 keeps the stricter rule for new dependencies: permissive open-source licenses only). Checked on 2026-10-10 with `pnpm -r licenses list --prod`: Apache-2.0, MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause and one `MIT OR EUPL-1.1+` package (used under MIT).
- The owner keeps the copyright of their own code; a future change of license for later versions stays possible as long as outside contributions are covered (a contributor agreement is a separate decision when contributions arrive).

## Alternatives

- **MIT / Apache-2.0:** maximal adoption, but anyone may ship a closed, paid or hosted version without sharing changes.
- **GPL-3.0:** copyleft for distributed copies only; a hosted service built on the code would not have to share changes.
- **PolyForm Noncommercial / source-available:** not an open-source license; blocks ordinary business use by the people the product is for (people doing their own outreach).
- **No license:** the code is visible but legally unusable; contributions have no terms.

## Consequences

- Anyone may use, study, modify and redistribute the app, including commercially, provided that modified versions — including ones offered over a network — are released under the same license with their source.
- Signed builds and the DMG carry the same license; the About text and user docs (Phase 8e) state it.
- Dependencies with AGPL-incompatible licenses (proprietary, SSPL, Commons Clause, GPL-2.0-only) cannot be added.

## Migration impact

None: no code or data changes.
