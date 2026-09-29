import type { Condition, PageState } from './schema.js';

/** What state matching needs to know about a page; the worker answers it with Playwright. */
export interface PageProbe {
  url: string;
  frameUrls: readonly string[];
  /** An element with this role (and accessible name containing `name`, case-insensitive). */
  hasRole(role: string, options: { name?: string; level?: number }): Promise<boolean>;
  /** Visible text containing this, case-insensitive. */
  hasText(text: string): Promise<boolean>;
}

/** URL glob: `*` matches any run of characters; everything else literally, whole string. */
export function urlMatches(pattern: string, url: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`);
  return regex.test(url);
}
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export async function conditionHolds(c: Condition, probe: PageProbe): Promise<boolean> {
  if ('frameUrlAny' in c) return probe.frameUrls.some((f) => c.frameUrlAny.some((p) => urlMatches(p, f)));
  if ('textAny' in c) {
    for (const text of c.textAny) if (await probe.hasText(text)) return true;
    return false;
  }
  const names = c.nameAny ?? (c.name ? [c.name] : [undefined]);
  for (const name of names) {
    if (await probe.hasRole(c.role, { ...(name ? { name } : {}), ...(c.level ? { level: c.level } : {}) }))
      return true;
  }
  return false;
}

export async function stateMatches(state: PageState, probe: PageProbe): Promise<boolean> {
  if (!state.url.some((p) => urlMatches(p, probe.url))) return false;
  for (const c of state.requires) if (!(await conditionHolds(c, probe))) return false;
  for (const c of state.forbids) if (await conditionHolds(c, probe)) return false;
  return true;
}

/**
 * The page's state from the allowlist (docs/07 "Page-state recognition"): a challenge first — it
 * takes priority over anything else — then the others in pack order; null means unsupported.
 */
export async function matchState(states: readonly PageState[], probe: PageProbe): Promise<PageState | null> {
  const ordered = [
    ...states.filter((s) => s.kind === 'challenge'),
    ...states.filter((s) => s.kind !== 'challenge'),
  ];
  for (const state of ordered) if (await stateMatches(state, probe)) return state;
  return null;
}
