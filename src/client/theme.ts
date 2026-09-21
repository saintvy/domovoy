export type Theme = 'light' | 'dark';
const key = 'domovoy-theme';
export function readTheme(): Theme {
  try {
    return localStorage.getItem(key) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#10291f' : '#172e25');
}
export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(key, theme);
  } catch {
    /* Still works in this tab. */
  }
  applyTheme(theme);
}
export function initializeTheme() {
  applyTheme(readTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === key || event.key === null) applyTheme(readTheme());
  });
}
