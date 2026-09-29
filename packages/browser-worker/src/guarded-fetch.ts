import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
/** Headers Chrome must not get back as they came: the body is sent decoded and whole. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

export interface GuardedResponse {
  /** Where the response came from, after redirects. */
  url: URL;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class BlockedAddressError extends Error {
  constructor(readonly host: string) {
    super(`blocked address: ${host}`);
  }
}

/**
 * One HTTP request made by the worker for a research page (ADR 027, audit 5.5). The connection
 * goes to the very address that was checked (a pinned `lookup`), so DNS rebinding cannot swap in
 * a local address. Redirects are followed here, each hop checked the same way and by `allowHop`:
 * Chrome would follow a 3xx it is given without asking again. No cookies go out or come back.
 */
export async function guardedFetch(
  url: URL,
  init: { method: string; headers: Record<string, string>; body: Buffer | null },
  rules: { isPublic: (ip: string) => boolean; resolve: (host: string) => Promise<string[]> },
  signal: AbortSignal,
  /** A redirect target the caller refuses (off the site, for the page itself). */
  allowHop: (next: URL) => boolean = () => true,
): Promise<GuardedResponse> {
  let current = url;
  let request = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchOnce(current, request, rules, signal);
    const location = res.status >= 300 && res.status < 400 ? res.headers.location : undefined;
    if (!location) return res;
    const next = new URL(location, current);
    if (!/^https?:$/.test(next.protocol) || !allowHop(next)) throw new RedirectRefusedError(next);
    // 303, and 301/302 after a POST, become a GET without a body (as browsers do).
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && request.method === 'POST')) {
      request = { method: 'GET', headers: request.headers, body: null };
    }
    current = next;
  }
  throw new RedirectRefusedError(current);
}

export class RedirectRefusedError extends Error {
  constructor(readonly target: URL) {
    super(`redirect refused: ${target.origin}`);
  }
}

async function fetchOnce(
  url: URL,
  init: { method: string; headers: Record<string, string>; body: Buffer | null },
  rules: { isPublic: (ip: string) => boolean; resolve: (host: string) => Promise<string[]> },
  signal: AbortSignal,
): Promise<GuardedResponse> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !rules.isPublic(host)) throw new BlockedAddressError(host);
  const lookup: LookupFunction = (hostname, options, callback) => {
    rules.resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(rules.isPublic)) {
          callback(new BlockedAddressError(hostname), '');
          return;
        }
        const list = addresses.map((address) => ({ address, family: isIP(address) }));
        const [first] = list;
        if (options.all) callback(null, list);
        else if (first) callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), ''),
    );
  };
  const headers = { ...init.headers };
  for (const name of Object.keys(headers)) {
    if (/^(cookie|accept-encoding|host|connection|content-length)$/i.test(name)) delete headers[name];
  }
  headers['accept-encoding'] = 'identity';
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<GuardedResponse>((resolve, reject) => {
    const req = send(
      url,
      {
        method: init.method,
        headers,
        lookup,
        // A fresh connection every time: a pooled socket would skip the address check above.
        agent: false,
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('too_large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) {
            if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
            out[name] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({ url, status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(init.body ?? undefined);
  });
}
