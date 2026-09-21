import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

export default function ShellUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let live = true;
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then((registration) => {
        if (!live) return;
        if (registration.waiting) setWaiting(registration.waiting);
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (
              live &&
              worker.state === 'installed' &&
              navigator.serviceWorker.controller
            )
              setWaiting(worker);
          });
        });
      })
      .catch(() => {
        /* The online application remains usable without a shell cache. */
      });
    return () => {
      live = false;
    };
  }, []);
  if (!waiting || dismissed) return null;
  const english = localStorage.getItem('domovoy-language') === 'en';
  function update() {
    const hasOpenDialog = !!document.querySelector('[role="dialog"]');
    const dirty = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'form input:not([type="checkbox"]):not([type="file"]),form textarea',
      ),
    ).some((input) => input.value !== input.defaultValue);
    if (hasOpenDialog || dirty) {
      setBlocked(true);
      return;
    }
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => window.location.reload(),
      { once: true },
    );
    waiting?.postMessage({ type: 'ACTIVATE_SHELL_UPDATE' });
  }
  return (
    <div className="shell-update" role="status">
      <RefreshCw size={16} />
      <span>
        {blocked
          ? english
            ? 'Save or close your open form before updating.'
            : 'Сохраните или закройте открытую форму перед обновлением.'
          : english
            ? 'An application update is ready.'
            : 'Готово обновление приложения.'}
      </span>
      <button onClick={update}>{english ? 'Update' : 'Обновить'}</button>
      <button
        className="icon-button"
        aria-label={english ? 'Later' : 'Позже'}
        onClick={() => setDismissed(true)}
      >
        <X size={15} />
      </button>
    </div>
  );
}
