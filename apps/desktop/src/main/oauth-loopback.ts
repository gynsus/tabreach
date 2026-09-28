import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Authorization servers the loopback flow may open (ADR 016). */
const ALLOWED_HOSTS = new Set(['accounts.google.com']);

export interface LoopbackResult {
  redirectUri: string;
  /** Query parameters of the redirect (`code`, `state`, or `error`). Checked by core, never logged here. */
  params: Record<string, string>;
}

const PAGE = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>TabReach</title>` +
  `<body style="font:15px -apple-system,system-ui;padding:3rem;color:#222"><p>${title}</p></body>`;

/**
 * One OAuth authorization through the system browser with a loopback redirect (docs/18, CLAUDE.md
 * §3.11): a listener on 127.0.0.1 and a random port, alive only until the first redirect arrives
 * or `timeoutMs` passes. PKCE and `state` are core's: this function only carries the redirect back.
 */
export function runLoopback(options: {
  authorizeUrl: string;
  timeoutMs: number;
  /** The `state` core put in the URL; other requests are answered and ignored. */
  expectedState: string;
  open: (url: string) => Promise<void>;
}): Promise<LoopbackResult> {
  const url = new URL(options.authorizeUrl);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) {
    return Promise.reject(new Error('Authorization URL is not allowed'));
  }
  return new Promise<LoopbackResult>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const server: Server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const params = Object.fromEntries(reqUrl.searchParams.entries());
      if (reqUrl.pathname !== '/' || (!params.code && !params.error)) {
        // Favicon requests and the like: not the redirect.
        res.writeHead(404).end();
        return;
      }
      if (params.state !== options.expectedState) {
        // Not our authorization (a stray or probing request): keep waiting for the real one.
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unexpected request');
        return;
      }
      const ok = Boolean(params.code);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(
        PAGE(
          ok
            ? 'TabReach is connected. You can close this tab.'
            : 'Authorization was not completed. You can close this tab.',
        ),
      );
      finish(() => resolve({ redirectUri, params }));
    });
    let redirectUri = '';
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      settle();
    };
    server.on('error', (error) => finish(() => reject(error)));
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      redirectUri = `http://127.0.0.1:${port}`;
      url.searchParams.set('redirect_uri', redirectUri);
      timer = setTimeout(() => finish(() => reject(new Error('Authorization timed out'))), options.timeoutMs);
      options.open(url.toString()).catch((error: unknown) => finish(() => reject(error)));
    });
  });
}
