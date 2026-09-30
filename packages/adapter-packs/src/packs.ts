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
/**
 * LinkedIn (Phase 7, docs/14): sign-in states, profile states, the invitation and message
 * actions, the thread reader and the product's own throttles. Names list the English and Russian
 * interface. These states were built against representative fixtures; real LinkedIn pages are
 * checked by hand and the pack is versioned whenever they change (ADR 017).
 */
const IN = 'https://www.linkedin.com/in/*';
// On real profile pages the person's name is the first level-2 heading (live check, 2026-09-30).
const heading = { role: 'heading', level: 2 };
const button = (...nameAny: string[]) => ({ role: 'button', nameAny });
const linkedin = {
  id: 'linkedin',
  version: '0.3.0',
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
        'https://www.linkedin.com/authwall*',
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
    // Dialogs first: over a profile, the profile's own buttons are still there.
    {
      id: 'linkedin.invite.note',
      url: [IN],
      requires: [{ role: 'dialog' }, { role: 'textbox', nameAny: ['Add a note', 'Добавьте заметку'] }],
    },
    {
      id: 'linkedin.invite.dialog',
      url: [IN],
      requires: [{ role: 'dialog' }, button('Send without a note', 'Отправить без заметки')],
    },
    {
      id: 'linkedin.composer',
      url: [IN],
      requires: [
        { role: 'dialog', nameAny: ['Messaging', 'Сообщения'] },
        { role: 'textbox', nameAny: ['Write a message', 'Напишите сообщение'] },
      ],
    },
    {
      id: 'linkedin.invite.sent',
      url: [IN],
      requires: [heading, { textAny: ['Invitation sent', 'Приглашение отправлено'] }],
    },
    { id: 'linkedin.profile.pending', url: [IN], requires: [heading, button('Pending', 'Ожидание')] },
    {
      id: 'linkedin.profile.connectable',
      url: [IN],
      requires: [heading, button('Connect', 'Установить контакт')],
    },
    // "Message" is a link on real profile pages (to /messaging/compose/), opening the composer over the page.
    {
      id: 'linkedin.profile.messageable',
      url: [IN],
      requires: [heading, { role: 'link', nameAny: ['Message', 'Сообщение'] }],
    },
  ],
  actions: [
    {
      id: 'linkedin.connect',
      from: ['linkedin.profile.connectable'],
      identity: true,
      steps: [{ click: button('Connect', 'Установить контакт'), expect: ['linkedin.invite.dialog'] }],
      commit: button('Send without a note', 'Отправить без заметки'),
      success: ['linkedin.invite.sent', 'linkedin.profile.pending'],
    },
    {
      id: 'linkedin.connect.note',
      from: ['linkedin.profile.connectable'],
      identity: true,
      steps: [
        { click: button('Connect', 'Установить контакт'), expect: ['linkedin.invite.dialog'] },
        { click: button('Add a note', 'Добавить заметку'), expect: ['linkedin.invite.note'] },
      ],
      fill: [{ control: { role: 'textbox', nameAny: ['Add a note', 'Добавьте заметку'] }, param: 'note' }],
      commit: button('Send', 'Отправить'),
      success: ['linkedin.invite.sent', 'linkedin.profile.pending'],
    },
    {
      id: 'linkedin.message',
      from: ['linkedin.profile.messageable'],
      identity: true,
      steps: [{ click: { role: 'link', nameAny: ['Message', 'Сообщение'] }, expect: ['linkedin.composer'] }],
      fill: [
        {
          control: {
            role: 'textbox',
            nameAny: ['Write a message…', 'Write a message', 'Напишите сообщение…', 'Напишите сообщение'],
          },
          param: 'body',
        },
      ],
      commit: button('Send', 'Отправить'),
      // LinkedIn says nothing like "sent": the new message of ours in the thread is the proof.
      confirm: { reader: 'linkedin.thread' },
    },
  ],
  readers: [
    {
      id: 'linkedin.thread',
      from: ['linkedin.profile.messageable'],
      identity: true,
      steps: [{ click: { role: 'link', nameAny: ['Message', 'Сообщение'] }, expect: ['linkedin.composer'] }],
      within: { role: 'dialog', nameAny: ['Messaging', 'Сообщения'] },
      profileLinkAny: ['profile', 'профил'],
    },
  ],
  identity: { name: { role: 'heading', level: 2, within: 'main' }, profilePath: '/in/' },
  // Product defaults, not LinkedIn's limits and no guarantee against restrictions (FR-LIN-005).
  limits: {
    perDay: { connect: 15, message: 30, visit: 60 },
    perWeek: { connect: 80 },
    minSpacingSeconds: 90,
  },
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
