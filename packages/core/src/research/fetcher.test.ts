import { describe, expect, it } from 'vitest';
import { isPublicAddress, PageFetcher } from './fetcher.js';

const html = (body: string) =>
  new Response(`<html><body>${body}</body></html>`, { headers: { 'content-type': 'text/html' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

/** A fake web: answers by URL, remembers every request. */
function web(pages: Record<string, () => Response>, addresses: Record<string, string[]> = {}) {
  const requested: string[] = [];
  const fetcher = new PageFetcher(
    async (url) => {
      requested.push(url);
      const page = pages[url];
      if (!page) throw new Error(`no route ${url}`);
      return page();
    },
    async () => {},
    async (host) => addresses[host] ?? ['93.184.216.34'],
  );
  return { fetcher, requested };
}
const signal = new AbortController().signal;

describe('research page fetcher (audit 4.5)', () => {
  it('follows a redirect within the site, checking robots on the way', async () => {
    const { fetcher, requested } = web({
      'https://acme.test/robots.txt': () => new Response('', { status: 404 }),
      'https://acme.test/about': () => redirect('/about/'),
      'https://acme.test/about/': () => html('About Acme'),
    });
    expect(await fetcher.fetch('https://acme.test/about', 'acme.test', signal)).toMatchObject({
      ok: true,
      url: 'https://acme.test/about/',
    });
    expect(requested).toEqual([
      'https://acme.test/robots.txt',
      'https://acme.test/about',
      'https://acme.test/about/',
    ]);
  });

  it('never requests another site, a private address or an IP literal', async () => {
    const { fetcher, requested } = web(
      {
        'https://acme.test/robots.txt': () => new Response('', { status: 404 }),
        'https://acme.test/go': () => redirect('https://elsewhere.test/'),
        'https://acme.test/meta': () => redirect('http://169.254.169.254/latest'),
      },
      { 'intranet.acme.test': ['10.0.0.7'] },
    );
    expect(await fetcher.fetch('https://acme.test/go', 'acme.test', signal)).toMatchObject({
      reason: 'offsite',
    });
    expect(await fetcher.fetch('https://acme.test/meta', 'acme.test', signal)).toMatchObject({
      reason: 'offsite',
    });
    expect(await fetcher.fetch('http://192.168.1.1/', '192.168.1.1', signal)).toMatchObject({
      reason: 'blocked_address',
    });
    expect(await fetcher.fetch('https://intranet.acme.test/', 'acme.test', signal)).toMatchObject({
      reason: 'blocked_address',
    });
    expect(requested.some((u) => /elsewhere|169\.254|192\.168|intranet/.test(u))).toBe(false);
  });

  it('robots.txt: a server error allows nothing; a failed request is asked again next time', async () => {
    let robotsDown = true;
    const { fetcher } = web({
      'https://acme.test/robots.txt': () => {
        if (robotsDown) throw new Error('connection reset');
        return new Response('', { status: 404 });
      },
      'https://acme.test/': () => html('Home'),
      'https://busy.test/robots.txt': () => new Response('', { status: 503 }),
    });
    expect(await fetcher.fetch('https://acme.test/', 'acme.test', signal)).toMatchObject({
      reason: 'unreachable',
    });
    robotsDown = false;
    expect(await fetcher.fetch('https://acme.test/', 'acme.test', signal)).toMatchObject({ ok: true });
    expect(await fetcher.fetch('https://busy.test/', 'busy.test', signal)).toMatchObject({
      reason: 'robots',
    });
  });

  it('knows which addresses are public', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111'])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
});
