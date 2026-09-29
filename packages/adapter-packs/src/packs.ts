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

/**
 * Contact forms on any website (docs/14, Phase 6). Phrases are lower-case substrings, English and
 * Russian; order inside a list does not matter, but fields are matched in the order of FORM_FIELDS
 * with more specific ones (first/last name, email) winning over general ones (name).
 */
const webForm = {
  id: 'web-form',
  version: '1.0.0',
  channel: 'web_form',
  forms: {
    contactLinks: [
      'contact',
      'get in touch',
      'write to us',
      'reach us',
      'контакт',
      'связаться',
      'связь с нами',
      'обратная связь',
      'напишите нам',
      'написать нам',
    ],
    contactPaths: ['/contact', '/contacts', '/contact-us', '/kontakty', '/contact.html'],
    fields: {
      name: ['full name', 'fullname', 'your name', 'yourname', 'name', 'имя', 'фио', 'как к вам обращаться'],
      firstName: ['first name', 'given name', 'given-name', 'firstname', 'first_name', 'fname', 'имя'],
      lastName: [
        'last name',
        'surname',
        'family name',
        'family-name',
        'lastname',
        'last_name',
        'lname',
        'фамилия',
      ],
      email: ['email', 'e-mail', 'mail', 'почта', 'эл. почта', 'электронная почта'],
      phone: ['phone', 'tel', 'mobile', 'телефон', 'тел.'],
      company: ['company', 'organization', 'organisation', 'business', 'компания', 'организация'],
      website: ['website', 'web site', 'url', 'сайт'],
      subject: ['subject', 'topic', 'тема'],
      message: [
        'message',
        'comment',
        'how can we help',
        'your question',
        'inquiry',
        'enquiry',
        'details',
        'сообщение',
        'комментарий',
        'вопрос',
        'текст',
      ],
      consent: [
        'agree',
        'consent',
        'accept',
        'privacy',
        'marketing',
        'newsletter',
        'subscribe',
        'согласие',
        'согласен',
        'согласна',
        'соглашаюсь',
        'политик',
        'рассылк',
        'подписаться',
      ],
    },
    success: [
      'thank you',
      'thanks for',
      'message has been sent',
      'message was sent',
      'we will get back',
      "we'll get back",
      'we will be in touch',
      'спасибо',
      'сообщение отправлено',
      'заявка отправлена',
      'мы свяжемся',
    ],
    rejected: [
      'please correct',
      'is required',
      'required field',
      'invalid',
      'please enter',
      'обязательное поле',
      'заполните',
      'неверн',
      'некорректн',
      'исправьте',
    ],
  },
};

/** Where to go to find out whether a profile is signed in, per channel pack. */
export const SIGN_IN_CHECK_URL: Record<string, string> = {
  linkedin: 'https://www.linkedin.com/feed/',
};

export const bundledPacks: readonly AdapterPack[] = [generic, linkedin, webForm].map((p) =>
  parseAdapterPack(p),
);

export function bundledPack(id: string): AdapterPack | undefined {
  return bundledPacks.find((p) => p.id === id);
}
