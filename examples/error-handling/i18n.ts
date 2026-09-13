import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import it from './locales/it.json';

export const i18n = createInstance();

export async function initI18n(language: string): Promise<void> {
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    resources: {
      en: { translation: en },
      it: { translation: it },
    },
    interpolation: { escapeValue: false },
  });
}
