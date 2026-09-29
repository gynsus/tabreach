import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Http } from '../email/gmail.js';
import { ALLOW_ALL, parseRobots, type Robots } from './robots.js';

/** An honest user agent (docs/16 "Robots and site restrictions"). */
export const USER_AGENT = 'TabReachResearch/0.1 (+local research tool; respects robots.txt)';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** At most one request per second to the same host. */
const HOST_INTERVAL_MS = 1_000;

export type FetchResult =
  | { ok: true; url: string; html: string }
  | {
      ok: false;
      url: string;
      reason:
        'robots' | 'offsite' | 'blocked_address' | 'not_html' | 'too_large' | 'http_error' | 'unreachable';
    };

const MAX_REDIRECTS = 5;
/** Resolves a host name to its addresses (DNS in the app; fixed in tests). */
export type ResolveHost = (host: string) => Promise<string[]>;
const dnsResolve: ResolveHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address);
const DISALLOW_ALL: Robots = { allowed: () => false };

/**
 * Static page fetching for research: robots.txt, same site only, bounded size and time, polite
 * pacing (docs/16). Redirects are followed one hop at a time, each checked like the first request
 * (same site, robots, public address), so a page can never lead TabReach to another site or into
 * the user's local network (audit 4.5).
 */
export class PageFetcher {
  private readonly robots = new Map<string, Promise<Robots>>();
  private readonly lastRequest = new Map<string, number>();

  constructor(
    private readonly http: Http,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly resolveHost: ResolveHost = dnsResolve,
    private readonly onError: (url: string, error: unknown) => void = () => {},
  ) {}

  async fetch(url: string, site: string, signal: AbortSignal): Promise<FetchResult> {
    let current = new URL(url);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!sameSite(current.hostname, site) || !/^https?:$/.test(current.protocol))
        return { ok: false, url, reason: 'offsite' };
      if (!(await this.publicHost(current.hostname))) return { ok: false, url, reason: 'blocked_address' };
      const robots = await this.robotsFor(current.origin, signal);
      if (!robots) return { ok: false, url, reason: 'unreachable' };
      if (!robots.allowed(current.pathname + current.search)) return { ok: false, url, reason: 'robots' };
      const res = await this.request(current.toString(), signal);
      if (!res) return { ok: false, url, reason: 'unreachable' };
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location) {
        await res.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      if (!res.ok) return { ok: false, url, reason: 'http_error' };
      if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? ''))
        return { ok: false, url, reason: 'not_html' };
      const html = await readLimited(res, MAX_BYTES);
      if (html === null) return { ok: false, url, reason: 'too_large' };
      return { ok: true, url: current.toString(), html };
    }
    return { ok: false, url, reason: 'http_error' };
  }

  /** A host name (never an IP literal) whose every address is public. */
  private async publicHost(hostname: string): Promise<boolean> {
    const host = hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return false;
    try {
      const addresses = await this.resolveHost(host);
      return addresses.length > 0 && addresses.every(isPublicAddress);
    } catch (error) {
      this.onError(hostname, error);
      return false;
    }
  }

  /**
   * robots.txt of an origin: missing (4xx) allows everything, a server error (5xx) allows nothing
   * (RFC 9309). A failed request is not remembered, so the next fetch asks again; null means the
   * site could not be reached.
   */
  private async robotsFor(origin: string, signal: AbortSignal): Promise<Robots | null> {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    const res = await this.request(`${origin}/robots.txt`, signal);
    if (!res) return null;
    let robots: Robots;
    if (res.status >= 500) robots = DISALLOW_ALL;
    else if (!res.ok) robots = ALLOW_ALL;
    else {
      const text = await readLimited(res, 512 * 1024);
      robots = text ? parseRobots(text, USER_AGENT) : ALLOW_ALL;
    }
    this.robots.set(origin, Promise.resolve(robots));
    return robots;
  }

  private async request(url: string, signal: AbortSignal): Promise<Response | null> {
    const host = new URL(url).host;
    const wait = (this.lastRequest.get(host) ?? 0) + HOST_INTERVAL_MS - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequest.set(host, Date.now());
    try {
      return await this.http(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' },
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (error) {
      this.onError(url, error);
      return null;
    }
  }
}

/** Not loopback, private, link-local, carrier-grade NAT, multicast or reserved (IPv4 and IPv6). */
export function isPublicAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return false;
  return !/^(fc|fd|fe[89ab]|ff)/.test(v6);
}

/** Same registrable site, roughly: the host equals the site or is its subdomain (www.acme.com ~ acme.com). */
export function sameSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase().replace(/^www\./, '');
  return h === s || h.endsWith(`.${s}`);
}

async function readLimited(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
