import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let values: Map<string, string>;
beforeEach(() => {
  vi.resetModules();
  values = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ locale: 'en' }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('initial application language', () => {
  it('preserves a saved choice over browser and country hints', async () => {
    values.set('domovoy-language', 'en');
    vi.stubGlobal('navigator', { languages: ['ru-RU'] });
    const language = await import('../src/client/language');
    await language.initializeLanguage();
    expect(language.readLanguage()).toBe('en');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses Russian browser preferences without requesting geography', async () => {
    vi.stubGlobal('navigator', { languages: ['en', 'ru-RU'] });
    const language = await import('../src/client/language');
    await language.initializeLanguage();
    expect(language.readLanguage()).toBe('ru');
    expect(values.get('domovoy-language')).toBe('ru');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses and persists a country suggestion, otherwise English', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ locale: 'ru' })),
    );
    const language = await import('../src/client/language');
    await language.initializeLanguage();
    expect(language.readLanguage()).toBe('ru');
    expect(fetch).toHaveBeenCalledWith(
      '/api/locale',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
  it('falls back to English when geography fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const language = await import('../src/client/language');
    await language.initializeLanguage();
    expect(language.readLanguage()).toBe('en');
  });
  it('does not overwrite a manual choice with a late geography response', async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const language = await import('../src/client/language');
    const pending = language.initializeLanguage();
    language.saveLanguage('en');
    finish(new Response(JSON.stringify({ locale: 'ru' })));
    await pending;
    expect(language.readLanguage()).toBe('en');
  });
});
