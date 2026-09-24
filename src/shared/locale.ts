export type AppLocale = 'ru' | 'en';

export function isAppLocale(value: unknown): value is AppLocale {
  return value === 'ru' || value === 'en';
}

/** Accepts browser/Telegram language tags while keeping the supported set closed. */
export function normalizeAppLocale(
  value: unknown,
  fallback: AppLocale = 'en',
): AppLocale {
  if (typeof value !== 'string') return fallback;
  const language = value.trim().toLowerCase().split(/[-_]/, 1)[0];
  return isAppLocale(language) ? language : fallback;
}
