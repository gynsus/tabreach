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
      reason: 'robots' | 'offsite' | 'not_html' | 'too_large' | 'http_error' | 'unreachable';
    };

/** Static page fetching for research: robots.txt, same site only, bounded size and time, polite pacing. */
export class PageFetcher {
  private readonly robots = new Map<string, Promise<Robots>>();
  private readonly lastRequest = new Map<string, number>();

  constructor(
    private readonly http: Http,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async fetch(url: string, site: string, signal: AbortSignal): Promise<FetchResult> {
    const target = new URL(url);
    if (!sameSite(target.hostname, site) || !/^https?:$/.test(target.protocol))
      return { ok: false, url, reason: 'offsite' };
    const robots = await this.robotsFor(target.origin, signal);
    if (!robots.allowed(target.pathname + target.search)) return { ok: false, url, reason: 'robots' };
    const res = await this.request(url, signal);
    if (!res) return { ok: false, url, reason: 'unreachable' };
    const final = new URL(res.url || url);
    if (!sameSite(final.hostname, site)) return { ok: false, url, reason: 'offsite' };
    if (!res.ok) return { ok: false, url, reason: 'http_error' };
    if (!/text\/html|application\/xhtml/i.test(res.headers.get('content-type') ?? ''))
      return { ok: false, url, reason: 'not_html' };
    const html = await readLimited(res, MAX_BYTES);
    if (html === null) return { ok: false, url, reason: 'too_large' };
    return { ok: true, url: final.toString(), html };
  }

  private robotsFor(origin: string, signal: AbortSignal): Promise<Robots> {
    let robots = this.robots.get(origin);
    if (!robots) {
      robots = (async () => {
        const res = await this.request(`${origin}/robots.txt`, signal);
        if (!res || !res.ok) return ALLOW_ALL; // no robots.txt: everything is allowed
        const text = await readLimited(res, 512 * 1024);
        return text ? parseRobots(text, USER_AGENT) : ALLOW_ALL;
      })();
      this.robots.set(origin, robots);
    }
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
        redirect: 'follow',
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch {
      return null;
    }
  }
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
