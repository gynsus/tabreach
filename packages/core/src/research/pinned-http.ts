import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress } from '@tabreach/protocol';
import type { Http } from '../email/gmail.js';

/**
 * HTTP for research fetching whose connection goes to the address that was checked (audit 5.5):
 * the fetcher checks a host, then `fetch` would resolve it again — a DNS answer that changes in
 * between (DNS rebinding) could point it at the user's own network. Here the lookup itself refuses
 * non-public addresses and the socket connects to exactly what it returned. Redirects are never
 * followed (the fetcher follows them hop by hop).
 */
export function pinnedHttp(
  resolve: (host: string) => Promise<string[]> = async (host) =>
    (await dnsLookup(host, { all: true })).map((a) => a.address),
  /** Tests count the loopback server as public. */
  isPublic: (ip: string) => boolean = isPublicAddress,
): Http {
  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(isPublic)) {
          callback(new Error(`blocked address for ${hostname}`), '');
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
  return (url, init) =>
    new Promise<Response>((resolveResponse, reject) => {
      const target = new URL(url);
      const host = target.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !isPublic(host)) {
        reject(new Error(`blocked address ${host}`));
        return;
      }
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        target,
        {
          method: init.method ?? 'GET',
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          lookup,
          agent: false, // a pooled socket would skip the address check
          ...(init.signal ? { signal: init.signal } : {}),
        },
        (res) => {
          const status = res.statusCode ?? 502;
          const body =
            status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
          resolveResponse(new Response(body, { status, headers: toHeaders(res.headers) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}
