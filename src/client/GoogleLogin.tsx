import { LoaderCircle, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';

export function GoogleLogin({
  t,
  busy,
  error,
  onLogin,
  children,
}: {
  t: (ru: string, en: string) => string;
  busy: boolean;
  error: string;
  onLogin: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="auth-form">
      <span className="large-icon">
        <LockKeyhole />
      </span>
      <h2>{t('С возвращением', 'Welcome home')}</h2>
      <p>
        {t(
          'Войдите через Google, чтобы создать семью или принять приглашение.',
          'Sign in with Google to create a household or accept an invitation.',
        )}
      </p>
      {error && (
        <div className="notice danger" role="alert">
          {error}
        </div>
      )}
      {children}
      <button className="button primary full" disabled={busy} onClick={onLogin}>
        {busy && <LoaderCircle className="spin" size={18} />}
        {t('Продолжить с Google', 'Continue with Google')}
      </button>
      <small>
        {t(
          'Пароль Google вводится только на странице Google. Доступ к вашим файлам и почте не запрашивается.',
          'Enter your Google password only on Google’s page. Your files and mailbox are not requested.',
        )}
      </small>
    </div>
  );
}
