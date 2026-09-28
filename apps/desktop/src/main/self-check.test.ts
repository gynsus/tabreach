import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ MessageChannelMain: class {} }));
const { parseSelfCheck } = await import('./self-check.js');

describe('parseSelfCheck', () => {
  it('is off by default', () => {
    expect(parseSelfCheck(['/Applications/TabReach.app/Contents/MacOS/TabReach'])).toEqual({
      enabled: false,
      url: null,
    });
  });

  it('runs component checks only without a URL', () => {
    expect(parseSelfCheck(['app', '--self-check'])).toEqual({ enabled: true, url: null });
  });

  it('adds a Chrome launch check with a URL', () => {
    expect(parseSelfCheck(['app', '--self-check=https://example.com'])).toEqual({
      enabled: true,
      url: 'https://example.com',
    });
  });
});
