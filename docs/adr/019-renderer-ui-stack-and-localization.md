# ADR 019 — Renderer UI stack and localization

**Status:** Accepted (2026-09-28, Phase 1)

## Context

Phase 1 introduces the first real screens: prospect lists of 10k+ rows, forms, an import wizard. The owner's decisions: English is the default language and Russian is supported from the start; Tailwind CSS and current best practices; **no commercial libraries**. The renderer runs under a strict CSP (`style-src 'self'`) in a sandboxed window.

## Decision

- **Styling:** Tailwind CSS 4 via `@tailwindcss/vite`. Semantic color tokens (`paper`, `ink`, `accent`, `ok`, `warn`, `bad`, …) are CSS variables with a dark variant from `prefers-color-scheme`; components use only token names. `clsx` + `tailwind-merge` + `class-variance-authority` for variants.
- **Components:** small in-house primitives (`components/ui.tsx`). Dialogs use the native `<dialog>` element, selects are native `<select>`. Radix-style libraries were not adopted: their dialogs inject `<style>` tags that the CSP blocks, and native elements give focus trapping, Escape and accessibility for free.
- **Data:** TanStack Query for all core calls; server-side paging (100 rows) with infinite loading.
- **Tables:** TanStack Table **8** (headless) + TanStack Virtual for virtualized rows. Table 9 was available but is a new major with a different API; 8.21 is stable and sufficient.
- **Routing:** React Router with a hash router (the packaged app loads from `file://`).
- **Icons:** lucide-react.
- **Localization:** i18next + react-i18next. `en.ts` is the source catalog; `ru.ts` is typed against its shape, so a missing key is a compile error. Languages with more plural forms may add `_few`/`_many`. The chosen language is stored in core settings (`settings.ui`) and applied before first paint.
- **Errors from core are keys, not text:** validation failures carry `fields: { email: 'email.invalid' }`, import row errors carry `reason: 'row.empty'`; the UI translates them via `errors.*`.
- **Licenses:** every dependency is MIT, ISC or Apache-2.0. New dependencies must have a permissive open-source license.

## Consequences

- One visual language, dark mode for free, no CSS written outside tokens.
- Adding a language = adding one typed catalog file.
- Core never produces user-facing sentences; it produces codes.
- Tailwind's class strings are verbose; variants live in `cva` definitions to keep components readable.
