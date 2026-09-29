import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export interface FixtureServer {
  /** Base URL, e.g. `http://127.0.0.1:53211/`. */
  url: string;
  close(): Promise<void>;
}

/** Serves `fixtures/sites/public` on an ephemeral loopback port for browser tests. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const requested = new URL(req.url ?? '/', 'http://fixture');
    const pathname = requested.pathname;
    // /redirect?to=<url>: a 302 to anywhere, for tests of redirect checks.
    if (pathname === '/redirect') {
      res.writeHead(302, { location: requested.searchParams.get('to') ?? '/' }).end();
      return;
    }
    // /hits: what was requested so far (tests prove a request never arrived).
    if (pathname === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
      return;
    }
    hits.push(pathname);
    const file = normalize(join(root, pathname.endsWith('/') ? `${pathname}index.html` : pathname));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    readFile(file).then(
      (body) =>
        res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body),
      () => res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'),
    );
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((ok, fail) => server.close((err) => (err ? fail(err) : ok()))),
  };
}
