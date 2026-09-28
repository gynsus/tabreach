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
};

export interface FixtureServer {
  /** Base URL, e.g. `http://127.0.0.1:53211/`. */
  url: string;
  close(): Promise<void>;
}

/** Serves `fixtures/sites/public` on an ephemeral loopback port for browser tests. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://fixture').pathname;
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
