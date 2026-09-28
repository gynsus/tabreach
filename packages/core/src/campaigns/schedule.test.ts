import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nextAllowedAt, recipientTimeZone, zonedTime } from './schedule.js';

const weekdays = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
const at = (iso: string) => new Date(iso);

describe('nextAllowedAt', () => {
  it('keeps a time inside the window', () => {
    expect(nextAllowedAt(at('2026-09-28T10:15:00Z'), 'UTC', weekdays)).toEqual(at('2026-09-28T10:15:00Z'));
  });

  it('moves early times to the start and late ones to the next working day', () => {
    expect(nextAllowedAt(at('2026-09-28T06:00:00Z'), 'UTC', weekdays)).toEqual(at('2026-09-28T09:00:00Z'));
    expect(nextAllowedAt(at('2026-09-28T18:00:00Z'), 'UTC', weekdays)).toEqual(at('2026-09-29T09:00:00Z'));
    // Friday evening → Monday morning
    expect(nextAllowedAt(at('2026-10-02T19:00:00Z'), 'UTC', weekdays)).toEqual(at('2026-10-05T09:00:00Z'));
  });

  it("uses the recipient's zone", () => {
    // 07:00 UTC is 10:00 in Moscow (inside) and 03:00 in New York (before the window).
    expect(nextAllowedAt(at('2026-09-28T07:00:00Z'), 'Europe/Moscow', weekdays)).toEqual(
      at('2026-09-28T07:00:00Z'),
    );
    expect(nextAllowedAt(at('2026-09-28T07:00:00Z'), 'America/New_York', weekdays)).toEqual(
      at('2026-09-28T13:00:00Z'),
    );
    // Sunday evening in UTC is already Monday morning in Tokyo.
    expect(nextAllowedAt(at('2026-10-04T23:30:00Z'), 'Asia/Tokyo', weekdays)).toEqual(
      at('2026-10-05T00:00:00Z'),
    );
  });
});

describe('zonedTime', () => {
  it('handles daylight saving transitions', () => {
    expect(zonedTime(2026, 7, 1, 9, 0, 'America/New_York')).toEqual(at('2026-07-01T13:00:00Z'));
    expect(zonedTime(2026, 12, 1, 9, 0, 'America/New_York')).toEqual(at('2026-12-01T14:00:00Z'));
    // 02:30 does not exist on 2026-03-08 in New York: shifted forward by the jump.
    expect(zonedTime(2026, 3, 8, 2, 30, 'America/New_York')).toEqual(at('2026-03-08T07:30:00Z'));
    // 01:30 happens twice on 2026-11-01: the first (EDT) occurrence.
    expect(zonedTime(2026, 11, 1, 1, 30, 'America/New_York')).toEqual(at('2026-11-01T05:30:00Z'));
  });
});

describe('recipientTimeZone', () => {
  it('takes the first valid zone', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(recipientTimeZone(null, 'Mars/Olympus', 'Europe/Berlin')).toBe('Europe/Berlin');
    expect(recipientTimeZone('Asia/Tokyo', 'Europe/Berlin')).toBe('Asia/Tokyo');
  });
});
