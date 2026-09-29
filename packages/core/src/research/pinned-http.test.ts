import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pinnedHttp } from './pinned-http.js';

describe('pinned research HTTP (audit 5.5)', () => {
  let port: number;
  const server = createServer((req, res) => {
    if (req.url === '/moved') res.writeHead(302, { location: '/elsewhere' }).end();
    else
      res
        .writeHead(200, { 'content-type': 'text/html', 'x-seen-host': req.headers.host ?? '' })
        .end('<p>hi</p>');
  });
  beforeAll(async () => {
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  it('refuses a host that resolves to a local address, and local IP literals', async () => {
    const http = pinnedHttp(() => Promise.resolve(['127.0.0.1']));
    await expect(http(`http://rebind.test:${port}/`, {})).rejects.toThrow(/blocked address/);
    await expect(http(`http://127.0.0.1:${port}/`, {})).rejects.toThrow(/blocked address/);
    await expect(http(`http://[::ffff:7f00:1]:${port}/`, {})).rejects.toThrow(/blocked address/);
    // One answer public, another local: refused (every address must be public).
    const mixed = pinnedHttp(() => Promise.resolve(['93.184.216.34', '10.0.0.1']));
    await expect(mixed(`http://mixed.test:${port}/`, {})).rejects.toThrow(/blocked address/);
  });

  it('connects to the checked address and returns redirects as they came', async () => {
    const http = pinnedHttp(
      () => Promise.resolve(['127.0.0.1']),
      () => true,
    );
    const page = await http(`http://acme.test:${port}/`, {});
    expect(page.status).toBe(200);
    expect(page.headers.get('x-seen-host')).toBe(`acme.test:${port}`);
    expect(await page.text()).toBe('<p>hi</p>');
    const moved = await http(`http://acme.test:${port}/moved`, {});
    expect([moved.status, moved.headers.get('location')]).toEqual([302, '/elsewhere']);
  });
});
