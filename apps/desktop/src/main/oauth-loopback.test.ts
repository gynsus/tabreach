import { describe, expect, it } from 'vitest';
import { runLoopback } from './oauth-loopback';

const authorize = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1-long-enough-state';

describe('runLoopback', () => {
  it('opens the browser with a 127.0.0.1 redirect and returns the redirect parameters once', async () => {
    let opened = '';
    const result = runLoopback({
      authorizeUrl: authorize,
      expectedState: 's1-long-enough-state',
      timeoutMs: 5_000,
      open: async (url) => {
        opened = url;
        const redirect = new URL(url).searchParams.get('redirect_uri') as string;
        // The "browser": a favicon request and a stray request with another state first.
        await fetch(`${redirect}/favicon.ico`);
        expect((await fetch(`${redirect}/?error=access_denied&state=forged`)).status).toBe(400);
        const page = await fetch(`${redirect}/?code=abc&state=s1-long-enough-state`);
        expect(await page.text()).toContain('connected');
      },
    });
    const { redirectUri, params } = await result;
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(opened).searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(params).toEqual({ code: 'abc', state: 's1-long-enough-state' });
    // Single use: the listener is gone.
    await expect(fetch(`${redirectUri}/?code=again`)).rejects.toThrow();
  });

  it('returns an error redirect too, and times out when nothing comes back', async () => {
    const denied = await runLoopback({
      authorizeUrl: authorize,
      expectedState: 's1-long-enough-state',
      timeoutMs: 5_000,
      open: async (url) => {
        await fetch(
          `${new URL(url).searchParams.get('redirect_uri')}/?error=access_denied&state=s1-long-enough-state`,
        );
      },
    });
    expect(denied.params.error).toBe('access_denied');
    await expect(
      runLoopback({
        authorizeUrl: authorize,
        expectedState: 's1-long-enough-state',
        timeoutMs: 50,
        open: async () => {},
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('refuses anything but a known https authorization server', async () => {
    await expect(
      runLoopback({
        authorizeUrl: 'http://accounts.google.com/x',
        expectedState: 'x',
        timeoutMs: 100,
        open: async () => {},
      }),
    ).rejects.toThrow();
    await expect(
      runLoopback({
        authorizeUrl: 'https://evil.test/x',
        expectedState: 'x',
        timeoutMs: 100,
        open: async () => {},
      }),
    ).rejects.toThrow();
  });
});
