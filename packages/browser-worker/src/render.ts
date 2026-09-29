import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { matchState, type AdapterPack } from '@tabreach/adapter-packs';
import { isPublicAddress, sameSite, type RenderResult } from '@tabreach/protocol';
import type { BrowserContext, Route } from 'playwright-core';
import { probeOf } from './tasks.js';

const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_MS = 5_000;
const MAX_HTML = 2 * 1024 * 1024;
/** Not needed to read a page; skipping them keeps research light. */
const SKIPPED_TYPES = new Set(['image', 'media', 'font']);

export interface RenderEnvironment {
  /** Generic challenge states: a challenge is never solved, the page is skipped. */
  generic: AdapterPack | undefined;
  /** Address rules; tests allow the loopback fixture server. */
  isPublicAddress?: (ip: string) => boolean;
  resolveHost?: (host: string) => Promise<string[]>;
}

const dnsResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * RenderPageForResearch (docs/16, Phase 5d): the page of a JavaScript-only site, rendered in the
 * research profile. Every request of the page is checked: the page itself stays on the company's
 * site, and nothing — page, script, frame — reaches a non-public address (the user's own network).
 * Images, media and fonts are not loaded; popups are closed; WebSockets are refused.
 */
export async function renderForResearch(
  context: BrowserContext,
  req: { url: string; site: string },
  env: RenderEnvironment,
  signal: AbortSignal,
): Promise<RenderResult> {
  const isPublic = env.isPublicAddress ?? isPublicAddress;
  const resolve = env.resolveHost ?? dnsResolve;
  const hosts = new Map<string, Promise<boolean>>();
  const publicHost = (hostname: string): Promise<boolean> => {
    const host = hostname.replace(/^\[|\]$/g, '');
    let known = hosts.get(host);
    if (!known) {
      known = isIP(host)
        ? Promise.resolve(isPublic(host))
        : resolve(host).then(
            (addresses) => addresses.length > 0 && addresses.every(isPublic),
            () => false,
          );
      hosts.set(host, known);
    }
    return known;
  };
  const result = (over: Partial<RenderResult>): RenderResult => ({
    status: 'failed',
    url: null,
    title: null,
    html: null,
    reason: null,
    ...over,
  });

  const page = await context.newPage();
  let refused: 'offsite' | 'blocked_address' | null = null;
  const guard = async (route: Route) => {
    const request = route.request();
    const u = new URL(request.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue();
    const mainNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    if (!/^https?:$/.test(u.protocol)) return route.abort('blockedbyclient');
    if (mainNavigation && !sameSite(u.hostname, req.site)) {
      refused = 'offsite';
      return route.abort('blockedbyclient');
    }
    if (!(await publicHost(u.hostname))) {
      if (mainNavigation) refused = 'blocked_address';
      return route.abort('blockedbyclient');
    }
    if (SKIPPED_TYPES.has(request.resourceType())) return route.abort('blockedbyclient');
    return route.continue();
  };
  try {
    await page.route('**/*', guard);
    await page.routeWebSocket('**/*', (ws) => ws.close());
    page.on('popup', (popup) => void popup.close().catch(() => {}));
    signal.throwIfAborted();
    try {
      await page.goto(req.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      return result({
        status: refused ? 'blocked' : 'failed',
        url: page.url(),
        reason: refused ?? 'navigation',
      });
    }
    if (refused) return result({ status: 'blocked', url: page.url(), reason: refused });
    // Scripts fill the page after it loads; a busy page is read as it is after a few seconds.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    signal.throwIfAborted();
    if (refused) return result({ status: 'blocked', url: page.url(), reason: refused });
    const challenge = await matchState(
      (env.generic?.states ?? []).filter((s) => s.kind === 'challenge'),
      probeOf(page),
    ).catch(() => null);
    if (challenge) return result({ status: 'challenge', url: page.url(), reason: challenge.id });
    const html = await page.content();
    if (html.length > MAX_HTML) return result({ url: page.url(), reason: 'too_large' });
    return result({ status: 'ok', url: page.url(), title: await page.title().catch(() => null), html });
  } finally {
    await page.close().catch(() => {});
  }
}
