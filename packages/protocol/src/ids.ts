let lastMs = -1;
let counter = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, 12-bit monotonic counter, random bits.
 * Uses Web Crypto so it works in Node, utility processes and the sandboxed renderer.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  // 12-bit counter in rand_a (RFC 9562 section 6.2, method 1): ids created in the same millisecond
  // by this process still sort in creation order.
  let ms = now;
  if (ms <= lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1; // counter exhausted: borrow the next millisecond
      counter = 0;
    }
    ms = lastMs;
  } else {
    lastMs = ms;
    counter = 0;
  }
  bytes[6] = 0x70 | (counter >> 8); // version 7 + counter high bits
  bytes[7] = counter & 0xff;

  let ts = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts & 0xff;
    ts = Math.floor(ts / 256);
  }
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
