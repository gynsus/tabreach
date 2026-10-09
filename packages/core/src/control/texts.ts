import type { Language } from '@tabreach/protocol';

/**
 * The few texts core itself shows outside the app window: native notifications and the in-page
 * overlay. Everything else is translated in the renderer.
 */
const TEXTS = {
  en: {
    'overlay.signInCheck': 'Checking sign-in to {site}',
    'overlay.manual.message': 'Send this message yourself: copy the text, paste it and press Send',
    'overlay.manual.connect':
      'Send this invitation yourself: press Connect, and copy the note if you add one',
    'overlay.manual.detail': 'Then tell TabReach whether it was sent (Status → Needs attention).',
    'notify.title': 'TabReach needs you',
    'notify.security_challenge': 'A security check in “{profile}”. Open TabReach → Status.',
    'notify.login_required': 'Sign-in needed in “{profile}”.',
    'notify.unsupported_state': 'TabReach does not recognize the page in “{profile}”.',
    'notify.user_control': 'Paused in “{profile}”. Return control in TabReach when you are done.',
  },
  ru: {
    'overlay.signInCheck': 'Проверяю вход в {site}',
    'overlay.manual.message': 'Отправьте сообщение сами: скопируйте текст, вставьте и нажмите «Отправить»',
    'overlay.manual.connect':
      'Отправьте приглашение сами: нажмите «Установить контакт» и скопируйте заметку, если добавляете её',
    'overlay.manual.detail': 'Потом отметьте в TabReach, ушло ли оно (Состояние → Требует внимания).',
    'notify.title': 'TabReach нужны вы',
    'notify.security_challenge': 'Проверка безопасности в «{profile}». Откройте TabReach → Состояние.',
    'notify.login_required': 'Нужен вход в «{profile}».',
    'notify.unsupported_state': 'TabReach не узнаёт страницу в «{profile}».',
    'notify.user_control': 'Пауза в «{profile}». Верните управление в TabReach, когда закончите.',
  },
} as const;
export type CoreTextKey = keyof (typeof TEXTS)['en'];

export function coreText(lang: Language, key: CoreTextKey, vars: Record<string, string> = {}): string {
  return TEXTS[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '');
}
