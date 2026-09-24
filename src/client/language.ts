import type { AppLocale } from '../shared/locale';

export type AppLanguage = AppLocale;
const key = 'domovoy-language';
let inMemory: AppLanguage | undefined;

function savedLanguage(): AppLanguage | undefined {
  try {
    const value = localStorage.getItem(key);
    return value === 'ru' || value === 'en' ? value : undefined;
  } catch {
    return inMemory;
  }
}

export function browserUsesRussian(): boolean {
  return [...(navigator.languages ?? []), navigator.language ?? ''].some(
    (language) => /^ru(?:-|$)/i.test(language),
  );
}

export function readLanguage(): AppLanguage {
  return savedLanguage() ?? inMemory ?? (browserUsesRussian() ? 'ru' : 'en');
}

export function saveLanguage(language: AppLanguage) {
  inMemory = language;
  try {
    localStorage.setItem(key, language);
  } catch {
    // A blocked storage area must not prevent using the current tab.
  }
}

/** Country is a cosmetic hint; no external geolocation service or IP storage. */
export async function initializeLanguage(): Promise<void> {
  if (savedLanguage()) return;
  if (browserUsesRussian()) {
    saveLanguage('ru');
    return;
  }
  let suggested: AppLanguage = 'en';
  try {
    const response = await fetch('/api/locale', {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok && (await response.json()).locale === 'ru')
      suggested = 'ru';
  } catch {
    // Geography is optional and must not block sign-in.
  }
  if (!savedLanguage() && !inMemory) saveLanguage(suggested);
}
