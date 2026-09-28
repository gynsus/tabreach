import { describe, expect, it } from 'vitest';
import { RestartPolicy } from './restart-policy.js';

describe('RestartPolicy', () => {
  it('backs off exponentially and gives up after too many crashes in the window', () => {
    const policy = new RestartPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxCrashes: 3,
      windowMs: 60_000,
    });
    expect(policy.onCrash(0)).toEqual({ restart: true, delayMs: 1_000, recentCrashes: 1 });
    expect(policy.onCrash(1_000)).toEqual({ restart: true, delayMs: 2_000, recentCrashes: 2 });
    expect(policy.onCrash(2_000)).toEqual({ restart: true, delayMs: 4_000, recentCrashes: 3 });
    expect(policy.onCrash(3_000)).toEqual({ restart: false, delayMs: 0, recentCrashes: 4 });
  });

  it('forgets crashes outside the window', () => {
    const policy = new RestartPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxCrashes: 2,
      windowMs: 10_000,
    });
    policy.onCrash(0);
    policy.onCrash(1_000);
    expect(policy.onCrash(20_000)).toEqual({ restart: true, delayMs: 1_000, recentCrashes: 1 });
  });

  it('caps the delay', () => {
    const policy = new RestartPolicy({
      baseDelayMs: 1_000,
      maxDelayMs: 3_000,
      maxCrashes: 10,
      windowMs: 60_000,
    });
    for (let i = 0; i < 4; i++) policy.onCrash(i);
    expect(policy.onCrash(5).delayMs).toBe(3_000);
  });
});
