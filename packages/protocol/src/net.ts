/**
 * Address rules shared by core's research fetcher and the worker's research renderer (docs/16,
 * audit 4.5): research never reaches the user's own network and never leaves the company's site.
 */

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
