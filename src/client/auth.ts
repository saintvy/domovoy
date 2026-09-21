/** Public OAuth configuration. No AWS keys or Google client secret belong here. */
export interface RuntimeConfig {
  apiBaseUrl: string;
  cognitoDomain?: string;
  cognitoClientId?: string;
  cognitoRedirectUri?: string;
  cognitoUserPoolId?: string;
  region?: string;
  authMode?: 'cognito' | 'unconfigured';
}
const TOKEN_KEY = 'brownie-cognito-id';
const REFRESH_KEY = 'brownie-cognito-refresh';
const SESSION_KEY = 'brownie-app-session';
const FLOW_KEY = 'brownie-oauth-pkce';
const LOGIN_INTENT_KEY = 'brownie-login-after-signout';
let config: RuntimeConfig = { apiBaseUrl: '/api', authMode: 'unconfigured' };
let initializationError = '';
let authGeneration = 0;
let refreshPending: Promise<boolean> | undefined;
export class AuthRefreshError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export const runtimeConfig = () => config;
export const authEpoch = () => authGeneration;
export const authError = () => initializationError;
const loopbackDevelopment = () =>
  import.meta.env.DEV && ['127.0.0.1', 'localhost'].includes(location.hostname);
export const isAuthenticated = () => !!sessionStorage.getItem(TOKEN_KEY);
export const pendingInvitation = () =>
  sessionStorage.getItem('brownie-invitation');
export const clearInvitation = () =>
  sessionStorage.removeItem('brownie-invitation');
export function clearAuth() {
  authGeneration++;
  refreshPending = undefined;
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(FLOW_KEY);
  sessionStorage.removeItem(LOGIN_INTENT_KEY);
}
/** Refresh only this tab's credentials. A logout while the request is in flight wins. */
export async function ensureFreshIdToken(
  force = false,
  rejectedToken?: string,
): Promise<boolean> {
  const current = sessionStorage.getItem(TOKEN_KEY);
  if (!current) return false;
  if (force && rejectedToken && rejectedToken !== current) return true;
  let old: Record<string, unknown>;
  try {
    old = claims(current);
  } catch {
    throw new AuthRefreshError(
      'AUTH_REQUIRED',
      'Войдите через Google заново.',
      401,
    );
  }
  if (
    !force &&
    (!Number.isFinite(Number(old.exp)) ||
      Number(old.exp) * 1000 > Date.now() + 120000)
  )
    return false;
  if (refreshPending) return refreshPending;
  const refresh = sessionStorage.getItem(REFRESH_KEY),
    generation = authGeneration;
  if (!refresh || !config.cognitoDomain || !config.cognitoClientId) {
    if (Number(old.exp) * 1000 > Date.now() && !force) return false;
    throw new AuthRefreshError(
      'AUTH_REQUIRED',
      'Для включения автоматического продления войдите через Google ещё раз.',
      401,
    );
  }
  const pending = (async () => {
    let response: Response;
    try {
      response = await fetch(new URL('/oauth2/token', config.cognitoDomain), {
        method: 'POST',
        signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: config.cognitoClientId!,
          refresh_token: refresh,
        }),
      });
    } catch {
      throw new AuthRefreshError(
        'SESSION_REFRESH_UNAVAILABLE',
        'Не удалось продлить сессию: проверьте соединение. Изменения сохранены на устройстве.',
        503,
      );
    }
    const tokens = (await response.json().catch(() => ({}))) as {
      id_token?: string;
      refresh_token?: string;
      error?: string;
    };
    if (
      generation !== authGeneration ||
      sessionStorage.getItem(REFRESH_KEY) !== refresh
    )
      return false;
    if (!response.ok) {
      if (
        ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(
          tokens.error ?? '',
        )
      ) {
        clearAuth();
        throw new AuthRefreshError(
          'AUTH_REQUIRED',
          'Сессия Google завершена. Войдите снова.',
          401,
        );
      }
      throw new AuthRefreshError(
        'SESSION_REFRESH_UNAVAILABLE',
        'Сервис входа временно недоступен. Повторите попытку.',
        503,
      );
    }
    let next: Record<string, unknown>;
    try {
      next = claims(tokens.id_token ?? '');
    } catch {
      throw new AuthRefreshError(
        'SESSION_REFRESH_UNAVAILABLE',
        'Некорректный ответ сервиса входа.',
        503,
      );
    }
    if (
      !Number.isFinite(Number(next.exp)) ||
      Number(next.exp) * 1000 <= Date.now() ||
      ['sub', 'iss', 'aud'].some(
        (key) => old[key] !== undefined && old[key] !== next[key],
      )
    ) {
      clearAuth();
      throw new AuthRefreshError(
        'AUTH_REQUIRED',
        'Учётная запись сессии изменилась. Войдите снова.',
        401,
      );
    }
    sessionStorage.setItem(TOKEN_KEY, tokens.id_token!);
    if (tokens.refresh_token)
      sessionStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    return true;
  })();
  refreshPending = pending;
  try {
    return await pending;
  } finally {
    if (refreshPending === pending) refreshPending = undefined;
  }
}
export async function revokeRefreshToken(): Promise<void> {
  const token = sessionStorage.getItem(REFRESH_KEY);
  if (!token || !config.cognitoDomain || !config.cognitoClientId) return;
  try {
    await fetch(new URL('/oauth2/revoke', config.cognitoDomain), {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: config.cognitoClientId }),
    });
  } catch {
    /* Local logout still completes when the network is unavailable. */
  }
}
export function rememberSession(token: string) {
  sessionStorage.setItem(SESSION_KEY, token);
}
export function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  const session = sessionStorage.getItem(SESSION_KEY);
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(session ? { 'x-brownie-session': session } : {}),
  };
}
const base64url = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
function claims(token: string): Record<string, unknown> {
  const encoded = token.split('.')[1];
  if (!encoded) throw new Error('Некорректный ответ входа.');
  return JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')));
}
async function authorizeGoogle() {
  if (
    !config.cognitoDomain ||
    !config.cognitoClientId ||
    !config.cognitoRedirectUri
  )
    throw new Error(
      'Вход через Google ещё не настроен. Инструкция: docs/aws-access-and-deployment.md.',
    );
  const verifier = random(),
    state = random(),
    nonce = random();
  const challenge = base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
    ),
  );
  sessionStorage.setItem(
    FLOW_KEY,
    JSON.stringify({ verifier, state, nonce, createdAt: Date.now() }),
  );
  localStorage.setItem('domovoy-mode', 'server');
  const url = new URL('/oauth2/authorize', config.cognitoDomain);
  url.search = new URLSearchParams({
    client_id: config.cognitoClientId,
    redirect_uri: config.cognitoRedirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    identity_provider: 'Google',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  }).toString();
  location.assign(url);
}
export async function startGoogleLogin() {
  if (
    !config.cognitoDomain ||
    !config.cognitoClientId ||
    !config.cognitoRedirectUri
  )
    throw new Error('Вход через Google ещё не настроен.');
  clearAuth();
  localStorage.setItem('domovoy-mode', 'server');
  // Cognito Lite uses classic Hosted UI, where prompt=login is unavailable.
  // Clear its SSO cookie before a new PKCE authorization so auth_time advances.
  sessionStorage.setItem(LOGIN_INTENT_KEY, String(Date.now()));
  const url = new URL('/logout', config.cognitoDomain);
  url.search = new URLSearchParams({
    client_id: config.cognitoClientId,
    logout_uri: config.cognitoRedirectUri,
  }).toString();
  location.assign(url);
}
export async function createAppSession() {
  const response = await fetch(`${config.apiBaseUrl}/auth/session`, {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deviceName: navigator.userAgent.includes('Mobile')
        ? 'Mobile browser'
        : 'Browser',
    }),
  });
  const result = (await response.json()) as {
    sessionToken?: string;
    onboarding?: boolean;
    message?: string;
    error?: { message?: string };
  };
  if (
    !response.ok ||
    (!result.onboarding && typeof result.sessionToken !== 'string')
  )
    throw new Error(
      result.error?.message ||
        result.message ||
        'Нет доступа к домохозяйству. Администратор должен разрешить ваш Google-аккаунт.',
    );
  if (result.sessionToken) rememberSession(result.sessionToken);
  else sessionStorage.removeItem(SESSION_KEY);
}
export async function initializeAuth() {
  initializationError = '';
  try {
    const invitation = new URLSearchParams((location.hash ?? '').slice(1)).get(
      'invite',
    );
    if (invitation && /^[A-Za-z0-9_-]{43}$/.test(invitation)) {
      sessionStorage.setItem('brownie-invitation', invitation);
      history.replaceState(null, '', location.pathname + location.search);
    }
    let value: RuntimeConfig | undefined;
    try {
      const configurationResponse = await fetch('/runtime-config.json', {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      if (
        configurationResponse.ok &&
        configurationResponse.headers.get('content-type')?.includes('json')
      )
        value = (await configurationResponse.json()) as RuntimeConfig;
    } catch {
      const cached = localStorage.getItem('brownie-public-config');
      if (cached) value = JSON.parse(cached) as RuntimeConfig;
    }
    if (value) {
      if (typeof value.apiBaseUrl !== 'string')
        throw new Error('Не задан адрес API.');
      const apiUrl = new URL(value.apiBaseUrl, location.origin);
      if (
        apiUrl.protocol !== 'https:' &&
        !(loopbackDevelopment() && apiUrl.origin === location.origin)
      )
        throw new Error('Для API требуется HTTPS.');
      if (
        value.cognitoDomain &&
        new URL(value.cognitoDomain).protocol !== 'https:'
      )
        throw new Error('Для Cognito требуется HTTPS.');
      if (
        value.cognitoRedirectUri &&
        new URL(value.cognitoRedirectUri).origin !== location.origin
      )
        throw new Error(
          'Адрес возврата входа не совпадает с адресом приложения.',
        );
      config = { ...value, apiBaseUrl: value.apiBaseUrl.replace(/\/$/, '') };
      localStorage.setItem('brownie-public-config', JSON.stringify(config));
    }
    const query = new URLSearchParams(location.search);
    if (query.has('error')) {
      history.replaceState(null, '', location.pathname);
      sessionStorage.removeItem(FLOW_KEY);
      throw new Error('Google не завершил вход. Повторите попытку.');
    }
    const code = query.get('code');
    if (!code) {
      const intent = sessionStorage.getItem(LOGIN_INTENT_KEY);
      sessionStorage.removeItem(LOGIN_INTENT_KEY);
      if (
        intent &&
        Date.now() >= Number(intent) &&
        Date.now() - Number(intent) < 600_000
      )
        await authorizeGoogle();
      return;
    }
    const saved = sessionStorage.getItem(FLOW_KEY);
    sessionStorage.removeItem(FLOW_KEY);
    history.replaceState(null, '', location.pathname);
    const flow = saved ? JSON.parse(saved) : null;
    if (
      !flow ||
      flow.state !== query.get('state') ||
      Date.now() - flow.createdAt > 600_000 ||
      Date.now() < flow.createdAt
    )
      throw new Error(
        'Попытка входа истекла или не относится к этой вкладке. Начните вход заново.',
      );
    if (
      !config.cognitoDomain ||
      !config.cognitoClientId ||
      !config.cognitoRedirectUri
    )
      throw new Error('Вход не настроен.');
    clearAuth();
    const response = await fetch(
      new URL('/oauth2/token', config.cognitoDomain),
      {
        signal: AbortSignal.timeout(15000),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: config.cognitoClientId,
          redirect_uri: config.cognitoRedirectUri,
          code,
          code_verifier: flow.verifier,
        }),
      },
    );
    const tokens = (await response.json()) as {
      id_token?: string;
      refresh_token?: string;
    };
    if (
      !response.ok ||
      typeof tokens.id_token !== 'string' ||
      claims(tokens.id_token).nonce !== flow.nonce
    )
      throw new Error('Не удалось подтвердить вход. Повторите попытку.');
    // Decoding above binds this browser flow; only API Gateway validates the JWT signature.
    // Tokens stay in sessionStorage of this tab, never in persistent financial storage.
    sessionStorage.setItem(TOKEN_KEY, tokens.id_token);
    if (tokens.refresh_token)
      sessionStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    await createAppSession();
    localStorage.setItem('domovoy-mode', 'server');
  } catch (error) {
    clearAuth();
    initializationError = (error as Error).message;
  }
}
