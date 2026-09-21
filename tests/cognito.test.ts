import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class BrowserStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const configuration = {
  apiBaseUrl: 'https://api.example/api',
  cognitoDomain: 'https://test.auth.eu-central-1.amazoncognito.com',
  cognitoClientId: 'public-client',
  cognitoRedirectUri: 'https://brownie.example/',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const jwt = (nonce: string) =>
  'header.' +
  Buffer.from(JSON.stringify({ nonce })).toString('base64url') +
  '.signature';
let location: {
  origin: string;
  hostname: string;
  pathname: string;
  search: string;
  assign: ReturnType<typeof vi.fn>;
};
let session: BrowserStorage, local: BrowserStorage;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DEV', false);
  session = new BrowserStorage();
  local = new BrowserStorage();
  location = {
    origin: 'https://brownie.example',
    hostname: 'brownie.example',
    pathname: '/',
    search: '',
    assign: vi.fn(),
  };
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('location', location);
  vi.stubGlobal('navigator', { userAgent: 'Test browser', onLine: true });
  vi.stubGlobal('history', {
    replaceState: vi.fn(() => {
      location.search = '';
    }),
  });
  fetcher = vi.fn(async () => json(configuration));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function callback(state = 'state', age = 0) {
  session.setItem(
    'brownie-oauth-pkce',
    JSON.stringify({
      state: 'state',
      verifier: 'test-verifier',
      nonce: 'nonce',
      createdAt: Date.now() - age,
    }),
  );
  location.search = '?code=authorization-code&state=' + state;
}

describe('Cognito browser authorization boundary', () => {
  it('clears Cognito Lite SSO before a fresh authorization with PKCE S256 and independent state/nonce', async () => {
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    await auth.startGoogleLogin();
    const logout = new URL(location.assign.mock.calls[0][0]);
    expect(logout.pathname).toBe('/logout');
    expect(logout.searchParams.get('logout_uri')).toBe(
      configuration.cognitoRedirectUri,
    );
    await auth.initializeAuth();
    const authorize = new URL(location.assign.mock.calls[1][0]);
    expect(authorize.pathname).toBe('/oauth2/authorize');
    expect(authorize.searchParams.get('identity_provider')).toBe('Google');
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.has('prompt')).toBe(false);
    const flow = JSON.parse(session.getItem('brownie-oauth-pkce')!);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(flow.verifier),
    );
    expect(authorize.searchParams.get('code_challenge')).toBe(
      Buffer.from(digest).toString('base64url'),
    );
    expect(flow.state).not.toBe(flow.nonce);
    expect(flow.verifier).not.toBe(flow.state);
    expect(authorize.searchParams.get('state')).toBe(flow.state);
  });
  it.each([
    ['foreign-state', 0],
    ['state', 600_001],
  ])(
    'rejects wrong/expired state before exchanging a code (%s, %s)',
    async (state, age) => {
      callback(state, age);
      const auth = await import('../src/client/auth');
      await auth.initializeAuth();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(auth.isAuthenticated()).toBe(false);
      expect(session.getItem('brownie-oauth-pkce')).toBeNull();
      expect(location.search).toBe('');
      expect(auth.authError()).not.toBe('');
    },
  );
  it('validates nonce and keeps the refresh token only in this tab, never persistent storage', async () => {
    callback();
    const token = jwt('nonce');
    fetcher.mockImplementation(async (input: string | URL) => {
      const url = String(input);
      if (url === '/runtime-config.json') return json(configuration);
      if (url.endsWith('/oauth2/token'))
        return json({
          id_token: token,
          access_token: 'access',
          refresh_token: 'refresh-must-not-persist',
        });
      return json({ sessionToken: 's'.repeat(43) });
    });
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    const exchange = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith('/oauth2/token'),
    )!;
    expect(exchange[1].body.get('code_verifier')).toBe('test-verifier');
    expect(exchange[1].body.has('client_secret')).toBe(false);
    expect(exchange[1].signal).toBeInstanceOf(AbortSignal);
    const login = fetcher.mock.calls.find((call) =>
      String(call[0]).endsWith('/auth/session'),
    )!;
    expect(login[1].headers.Authorization).toBe('Bearer ' + token);
    expect(auth.authHeaders()).toEqual({
      Authorization: 'Bearer ' + token,
      'x-brownie-session': 's'.repeat(43),
    });
    expect(session.getItem('brownie-cognito-refresh')).toBe(
      'refresh-must-not-persist',
    );
    expect([...local.values.values()].join(' ')).not.toContain(
      'refresh-must-not-persist',
    );
    expect(auth.isAuthenticated()).toBe(true);
  });
  it('rejects a foreign nonce without creating an application session', async () => {
    callback();
    fetcher.mockImplementation(async (input: string | URL) =>
      String(input) === '/runtime-config.json'
        ? json(configuration)
        : json({ id_token: jwt('wrong') }),
    );
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(auth.authHeaders()).toEqual({});
    expect(auth.authError()).not.toBe('');
  });
  it('preserves the existing tab session if only the public configuration cannot be fetched offline', async () => {
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    session.setItem('brownie-cognito-id', jwt('nonce'));
    auth.rememberSession('s'.repeat(43));
    fetcher.mockRejectedValue(new TypeError('Network unavailable'));
    await auth.initializeAuth();
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.runtimeConfig().apiBaseUrl).toBe(configuration.apiBaseUrl);
  });
  it('cannot enable a production local identity with a runtime config flag or localhost hostname', async () => {
    location.hostname = 'localhost';
    const auth = await import('../src/client/auth');
    expect('localAuth' in auth).toBe(false);
    fetcher.mockResolvedValue(
      json({
        ...configuration,
        authMode: 'local',
        cognitoRedirectUri: 'https://foreign.example/',
      }),
    );
    await auth.initializeAuth();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.authError()).not.toBe('');
  });
  it('deduplicates refreshes, updates the ID token, and preserves the application session', async () => {
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    const token = (exp: number) =>
      'h.' +
      Buffer.from(
        JSON.stringify({ sub: 'member', iss: 'issuer', aud: 'client', exp }),
      ).toString('base64url') +
      '.s';
    session.setItem('brownie-cognito-id', token(Date.now() / 1000 + 30));
    session.setItem('brownie-cognito-refresh', 'tab-refresh');
    auth.rememberSession('application-session');
    const renewed = token(Date.now() / 1000 + 900);
    fetcher.mockImplementation(async (_url: unknown, options: any) => {
      expect(options.body.get('grant_type')).toBe('refresh_token');
      expect(options.body.get('refresh_token')).toBe('tab-refresh');
      return json({ id_token: renewed });
    });
    fetcher.mockClear();
    await Promise.all([
      auth.ensureFreshIdToken(),
      auth.ensureFreshIdToken(),
      auth.ensureFreshIdToken(),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(auth.authHeaders()).toEqual({
      Authorization: 'Bearer ' + renewed,
      'x-brownie-session': 'application-session',
    });
    expect(session.getItem('brownie-cognito-refresh')).toBe('tab-refresh');
  });
  it('does not log out on a temporary refresh outage and retries later', async () => {
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    session.setItem(
      'brownie-cognito-id',
      'h.' +
        Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') +
        '.s',
    );
    session.setItem('brownie-cognito-refresh', 'tab-refresh');
    fetcher.mockRejectedValue(new TypeError('offline'));
    await expect(auth.ensureFreshIdToken()).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
    });
    expect(auth.isAuthenticated()).toBe(true);
    expect(session.getItem('brownie-cognito-refresh')).toBe('tab-refresh');
    fetcher.mockResolvedValue(json({ error: 'invalid_grant' }, 400));
    await expect(auth.ensureFreshIdToken()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(auth.isAuthenticated()).toBe(false);
    expect(session.getItem('brownie-cognito-refresh')).toBeNull();
  });
  it('a refresh response cannot resurrect a logged-out session', async () => {
    const auth = await import('../src/client/auth');
    await auth.initializeAuth();
    session.setItem(
      'brownie-cognito-id',
      'h.' +
        Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url') +
        '.s',
    );
    session.setItem('brownie-cognito-refresh', 'tab-refresh');
    let finish!: (response: Response) => void;
    fetcher.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = auth.ensureFreshIdToken();
    auth.clearAuth();
    finish(json({ id_token: jwt('new'), refresh_token: 'replacement' }));
    await pending;
    expect(auth.isAuthenticated()).toBe(false);
    expect(session.getItem('brownie-cognito-refresh')).toBeNull();
  });
});
