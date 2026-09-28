import i18n, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Language } from '@tabreach/protocol';
import { en } from './en';
import { ru } from './ru';

export const languages: readonly Language[] = ['en', 'ru'];

declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof en };
  }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, ru: { translation: ru } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export async function setLanguage(language: Language): Promise<void> {
  await i18n.changeLanguage(language);
  document.documentElement.lang = language;
}

/**
 * Translate a key that is only known at runtime (error keys from core, action types). Returns the
 * fallback when the catalog has no such key, so an unexpected key never shows raw.
 */
export function translateKey(t: TFunction, key: string, fallback: string, options?: object): string {
  if (!i18n.exists(key)) return fallback;
  return (t as unknown as (k: string, o?: object) => string)(key, options);
}

export default i18n;
