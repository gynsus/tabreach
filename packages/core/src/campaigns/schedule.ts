import type { ActiveWindow } from '@tabreach/protocol';

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string | null | undefined): timeZone is string {
  if (!timeZone) return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The Mac's own zone: the last fallback when neither recipient nor campaign has one. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** First valid zone of contact → company → campaign → the Mac (docs/17, "Scheduling"). */
export function recipientTimeZone(...candidates: (string | null | undefined)[]): string {
  return candidates.find(isValidTimeZone) ?? localTimeZone();
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function wallClock(date: Date, timeZone: string): WallClock {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday ?? ''] ?? 1,
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const w = wallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. A time skipped by a DST jump is shifted
 * forward by the jump; a repeated one resolves to its first occurrence.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - offsetMs(new Date(guess), timeZone);
  const second = guess - offsetMs(new Date(first), timeZone);
  const matches = [first, second].filter((t) => {
    const w = wallClock(new Date(t), timeZone);
    return w.hour === hour && w.minute === minute && w.day === day;
  });
  return new Date(matches.length > 0 ? Math.min(...matches) : Math.max(first, second));
}

/**
 * The earliest instant ≥ `from` that lies inside the active window in `timeZone`. Deterministic, so
 * catch-up after sleep moves overdue work to the next window instead of bursting it out.
 */
export function nextAllowedAt(from: Date, timeZone: string, window: ActiveWindow): Date {
  const [sh, sm] = window.start.split(':').map(Number) as [number, number];
  const [eh, em] = window.end.split(':').map(Number) as [number, number];
  const today = wallClock(from, timeZone);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    const weekday = ((today.weekday - 1 + i) % 7) + 1;
    if (!window.days.includes(weekday)) continue;
    const [y, m, day] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    const start = zonedTime(y, m, day, sh, sm, timeZone);
    const end = zonedTime(y, m, day, eh, em, timeZone);
    if (from < end) return from > start ? from : start;
  }
  throw new Error('Active window has no days');
}

export function isInsideWindow(at: Date, timeZone: string, window: ActiveWindow): boolean {
  return nextAllowedAt(at, timeZone, window).getTime() === at.getTime();
}
