import { lookup } from 'node:dns/promises';
import { matchState, type AdapterPack } from '@tabreach/adapter-packs';
import { isPublicAddress, sameSite, type RenderResult } from '@tabreach/protocol';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { BlockedAddressError, guardedFetch, RedirectRefusedError } from './guarded-fetch.js';
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
 * RenderPageForResearch (docs/16, ADR 027): the page of a JavaScript-only site, rendered in the
 * research profile. Every request of the context — this page, its frames, redirect hops, anything
 * it opens — is made by the worker itself (`guardedFetch`), pinned to an address it checked: the
 * page stays on the company's site and nothing reaches a non-public address (the user's own
 * network). No cookies are sent or kept. Images, media and fonts are not loaded; other pages are
 * closed; WebSockets are refused.
 */
export async function renderForResearch(
  context: BrowserContext,
  req: { url: string; site: string },
  env: RenderEnvironment,
  signal: AbortSignal,
): Promise<RenderResult> {
  const rules = {
    isPublic: env.isPublicAddress ?? isPublicAddress,
    resolve: env.resolveHost ?? dnsResolve,
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
  /** The page's own URL after server redirects (Chrome still shows the first one). */
  let finalUrl: string | null = null;
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
    if (SKIPPED_TYPES.has(request.resourceType())) return route.abort('blockedbyclient');
    let response;
    try {
      response = await guardedFetch(
        u,
        { method: request.method(), headers: await request.allHeaders(), body: request.postDataBuffer() },
        rules,
        signal,
        (next) => !mainNavigation || sameSite(next.hostname, req.site),
      );
    } catch (error) {
      if (error instanceof BlockedAddressError || error instanceof RedirectRefusedError) {
        if (mainNavigation) refused = error instanceof BlockedAddressError ? 'blocked_address' : 'offsite';
        return route.abort('blockedbyclient');
      }
      // Unreachable, too large, timed out: the page goes without it.
      return route.abort('failed');
    }
    // Redirected: the document keeps its first URL in Chrome, so its relative links would point
    // to the wrong place; a <base> makes them resolve against where it really came from.
    const redirected = response.url.href !== u.href;
    if (mainNavigation && redirected) finalUrl = response.url.href;
    const body =
      redirected && /text\/html/i.test(response.headers['content-type'] ?? '')
        ? withBase(response.body, response.url.href)
        : response.body;
    return route.fulfill({ status: response.status, headers: response.headers, body });
  };
  const others = (other: Page) => {
    // Popups and other pages are not read; closing one that already went away is fine.
    if (other !== page) void other.close().catch(() => {});
  };
  try {
    await context.route('**/*', guard);
    await context.routeWebSocket('**/*', (ws) => ws.close());
    context.on('page', others);
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
    // A page that never goes quiet is read as it is (the timeout is the expected outcome).
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    signal.throwIfAborted();
    // A script may have navigated away meanwhile: only the company's own site is read.
    if (refused || !sameSite(new URL(page.url()).hostname, req.site)) {
      return result({ status: 'blocked', url: page.url(), reason: refused ?? 'offsite' });
    }
    const challenge = await matchState(
      (env.generic?.states ?? []).filter((s) => s.kind === 'challenge'),
      probeOf(page),
    ).catch(() => null); // a page that changes under the probe is simply not a challenge page
    if (challenge) return result({ status: 'challenge', url: page.url(), reason: challenge.id });
    const html = await page.content();
    if (html.length > MAX_HTML) return result({ url: page.url(), reason: 'too_large' });
    return result({
      status: 'ok',
      url: finalUrl ?? page.url(),
      title: await page.title().catch(() => null),
      html,
    });
  } finally {
    context.off('page', others);
    // Cleanup of a page that may already be gone (session closed, emergency stop).
    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.close().catch(() => {});
  }
}

/** Adds `<base href>` unless the document has its own. */
function withBase(body: Buffer, href: string): Buffer {
  const html = body.toString('utf8');
  if (/<base[\s>]/i.test(html)) return body;
  const tag = `<base href="${href.replace(/"/g, '&quot;')}">`;
  const withTag = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + tag) : tag + html;
  return Buffer.from(withTag, 'utf8');
}
