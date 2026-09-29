/**
 * Address rules shared by core's research fetcher and the worker's research renderer (docs/16,
 * audit 4.5): research never reaches the user's own network and never leaves the company's site.
 */

/** Not loopback, private, link-local, carrier-grade NAT, multicast or reserved (IPv4 and IPv6). */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return publicV4(v4);
  const v6 = parseV6(ip.replace(/^\[|\]$/g, ''));
  if (!v6) return false; // not an address we understand: never treat it as public
  return publicV6(v6);
}

function publicV4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function publicV6(h: number[]): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, , , h5 = 0, h6 = 0, h7 = 0] = h;
  const embedded = (hi: number, lo: number) => publicV4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]);
  const zeros = (n: number) => h.slice(0, n).every((x) => x === 0);
  // Addresses that carry an IPv4 address: judged by it (::ffff:7f00:1 is 127.0.0.1).
  if (zeros(5) && h5 === 0xffff) return embedded(h6, h7); // IPv4-mapped
  if (zeros(6)) return h6 !== 0 || h7 > 1 ? embedded(h6, h7) : false; // ::, ::1, IPv4-compatible
  if (h0 === 0x64 && h1 === 0xff9b) return false; // NAT64: whatever it wraps, never needed for research
  if (h0 === 0x2002) return embedded(h1, h2); // 6to4
  if ((h0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
  if ((h0 & 0xff00) === 0xff00) return false; // multicast
  if (h0 === 0x2001 && h1 === 0xdb8) return false; // documentation
  if (h0 === 0x100 && zeros(4)) return false; // discard
  return true;
}

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

/** Eight 16-bit groups, or null. Accepts `::` and a trailing dotted IPv4 part. */
function parseV6(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, ''); // zone id
  const tail = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = parseV4(tail[1] ?? '');
    if (!v4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = v4;
    text = `${text.slice(0, tail.index)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const head = groups(halves[0]);
  const rest = groups(halves[1]);
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

/** Same registrable site, roughly: the host equals the site or is its subdomain (www.acme.com ~ acme.com). */
export function sameSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const s = site.toLowerCase().replace(/^www\./, '');
  return h === s || h.endsWith(`.${s}`);
}
