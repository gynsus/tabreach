import { describe, expect, it } from 'vitest';
import { matchState, urlMatches, type PageProbe } from './match.js';
import { bundledPack, bundledPacks } from './packs.js';

const probe = (over: Partial<PageProbe> & { roles?: string[]; texts?: string[] }): PageProbe => ({
  url: over.url ?? 'https://example.com/',
  frameUrls: () => Promise.resolve(over.frameUrls ?? []),
  hasRole: async (role, { name }) =>
    (over.roles ?? []).some(
      (r) =>
        r.toLowerCase() === `${role} ${name ?? ''}`.trim().toLowerCase() ||
        (!name && r.split(' ')[0] === role),
    ),
  hasText: async (text) => (over.texts ?? []).some((t) => t.toLowerCase().includes(text.toLowerCase())),
});
const states = [...bundledPack('generic')!.states, ...bundledPack('linkedin')!.states];

describe('page state matching', () => {
  it('bundled packs are valid', () => {
    expect(bundledPacks.map((p) => p.id)).toEqual(['generic', 'linkedin', 'web-form']);
  });

  it('globs match the whole URL', () => {
    expect(urlMatches('https://www.linkedin.com/feed*', 'https://www.linkedin.com/feed/')).toBe(true);
    expect(
      urlMatches('https://www.linkedin.com/feed*', 'https://evil.test/?https://www.linkedin.com/feed'),
    ).toBe(false);
    expect(urlMatches('*recaptcha*', 'https://www.google.com/recaptcha/api2/anchor?k=1')).toBe(true);
  });

  it('a challenge wins over everything else, on any site', async () => {
    const page = probe({
      url: 'https://www.linkedin.com/feed/',
      roles: ['navigation', 'main'],
      frameUrls: ['https://www.google.com/recaptcha/api2/anchor?k=x'],
    });
    expect((await matchState(states, page))?.id).toBe('generic.captcha.recaptcha');
  });

  it('LinkedIn: signed in, sign-in page, security checkpoint, or unsupported', async () => {
    expect(
      (
        await matchState(
          states,
          probe({ url: 'https://www.linkedin.com/feed/', roles: ['navigation', 'main'] }),
        )
      )?.kind,
    ).toBe('logged_in');
    expect(
      (
        await matchState(
          states,
          probe({ url: 'https://www.linkedin.com/login', roles: ['textbox Email or phone'] }),
        )
      )?.id,
    ).toBe('linkedin.login');
    expect(
      (
        await matchState(
          states,
          probe({ url: 'https://www.linkedin.com/checkpoint/challenge/xyz', roles: ['heading'] }),
        )
      )?.kind,
    ).toBe('challenge');
    expect(
      await matchState(states, probe({ url: 'https://www.linkedin.com/feed/', roles: ['main'] })),
    ).toBeNull();
  });

  it('text and one-time code challenges, in English and Russian', async () => {
    expect((await matchState(states, probe({ texts: ['Please verify you are human'] })))?.id).toBe(
      'generic.human_check',
    );
    expect((await matchState(states, probe({ roles: ['textbox Код подтверждения'] })))?.id).toBe(
      'generic.one_time_code',
    );
  });
});
