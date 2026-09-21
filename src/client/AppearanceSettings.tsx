import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { readTheme, saveTheme, type Theme } from './theme';

export function AppearanceSettings({
  t,
}: {
  t: (ru: string, en: string) => string;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    const update = () => setTheme(readTheme());
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  return (
    <section className="panel settings-section appearance-settings">
      <div className="panel-heading">
        <h2>{t('Оформление', 'Appearance')}</h2>
        <Moon size={19} />
      </div>
      <div className="settings-body">
        <fieldset className="theme-options">
          <legend>{t('Тема приложения', 'Application theme')}</legend>
          {(['light', 'dark'] as const).map((value) => (
            <label className="theme-choice" key={value}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => {
                  setTheme(value);
                  saveTheme(value);
                }}
              />
              {value === 'light' ? <Sun size={19} /> : <Moon size={19} />}
              <span>
                {value === 'light'
                  ? t('Светлая', 'Light')
                  : t('Тёмная', 'Dark')}
              </span>
              <span className={`theme-swatch ${value}`} aria-hidden="true" />
            </label>
          ))}
        </fieldset>
        <p className="muted">
          {t(
            'Выбор сохраняется в этом браузере.',
            'Your choice is saved in this browser.',
          )}
        </p>
      </div>
    </section>
  );
}
