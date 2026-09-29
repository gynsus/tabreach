import { parseAdapterPack, type AdapterPack } from './schema.js';

/**
 * Packs bundled with the app (ADR 017). Data only: page states described by positive conditions.
 * Accessible names list UI-language variants (English, Russian).
 */

/** Security challenges on any site (docs/19 SECURITY_CHALLENGE): detected, never solved. */
const generic = {
  id: 'generic',
  version: '1.0.0',
  channel: 'generic',
  states: [
    {
      id: 'generic.captcha.recaptcha',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [{ frameUrlAny: ['*google.com/recaptcha/*', '*recaptcha.net/*', '*/recaptcha/*'] }],
    },
    {
      id: 'generic.captcha.hcaptcha',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [{ frameUrlAny: ['*hcaptcha.com/*'] }],
    },
    {
      id: 'generic.captcha.turnstile',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [{ frameUrlAny: ['*challenges.cloudflare.com/*'] }],
    },
    {
      id: 'generic.captcha.arkose',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [{ frameUrlAny: ['*arkoselabs.com/*', '*funcaptcha.com/*'] }],
    },
    {
      id: 'generic.human_check',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [
        {
          textAny: [
            'verify you are human',
            "i'm not a robot",
            'i am not a robot',
            'я не робот',
            'подтвердите, что вы человек',
          ],
        },
      ],
    },
    {
      id: 'generic.one_time_code',
      kind: 'challenge',
      url: ['https://*', 'http://127.0.0.1*'],
      requires: [
        {
          role: 'textbox',
          nameAny: [
            'verification code',
            'security code',
            'one-time code',
            'enter the code',
            'код подтверждения',
            'проверочный код',
            'введите код',
          ],
        },
      ],
    },
  ],
};

/**
 * LinkedIn sign-in states (Phase 5b). Only what "is this profile signed in?" needs; the adapter's
 * action states come with Phase 7.
 */
const linkedin = {
  id: 'linkedin',
  version: '0.1.0',
  channel: 'linkedin',
  states: [
    {
      id: 'linkedin.checkpoint',
      kind: 'challenge',
      url: ['https://www.linkedin.com/checkpoint/challenge*', 'https://www.linkedin.com/checkpoint/rp/*'],
      requires: [{ role: 'heading' }],
    },
    {
      id: 'linkedin.login',
      kind: 'login',
      url: [
        'https://www.linkedin.com/login*',
        'https://www.linkedin.com/uas/login*',
        'https://www.linkedin.com/checkpoint/lg/*',
        'https://www.linkedin.com/',
        'https://www.linkedin.com/?*',
      ],
      requires: [
        { role: 'textbox', nameAny: ['Email or phone', 'Email', 'Эл. почта или телефон', 'Эл. почта'] },
      ],
    },
    {
      id: 'linkedin.feed',
      kind: 'logged_in',
      url: ['https://www.linkedin.com/feed*'],
      requires: [{ role: 'navigation' }, { role: 'main' }],
    },
  ],
};

/** Where to go to find out whether a profile is signed in, per channel pack. */
export const SIGN_IN_CHECK_URL: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/feed/',
};

export const bundledPacks: readonly AdapterPack[] = [generic, linkedin].map((p) => parseAdapterPack(p));

export function bundledPack(id: string): AdapterPack | undefined {
  return bundledPacks.find((p) => p.id === id);
}
