import { afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../src/aws/handler';

afterEach(() => vi.unstubAllEnvs());
describe('Browser preflight regression', () => {
  it.each(['RU', 'BY', 'UA', 'CZ', 'US', undefined])(
    'provides a public, uncached locale hint for %s without database access',
    async (country) => {
      const result: any = await handler({
        version: '2.0',
        rawPath: '/api/locale',
        headers: country ? { 'cloudfront-viewer-country': country } : {},
        requestContext: { http: { method: 'GET' }, requestId: 'locale' },
      } as any);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(result.body)).toEqual({
        locale: ['RU', 'BY', 'UA'].includes(country ?? '') ? 'ru' : 'en',
      });
    },
  );
  it('responds without JWT or database credentials to OPTIONS on authenticated API paths', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://brownie.example');
    const result: any = await handler({
      version: '2.0',
      rawPath: '/api/auth/session',
      headers: {
        origin: 'https://brownie.example',
        'access-control-request-method': 'POST',
      },
      requestContext: { http: { method: 'OPTIONS' }, requestId: 'test' },
    } as any);
    expect(result.statusCode).toBe(204);
  });
  it('still rejects foreign origins and unauthenticated actual API calls', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://brownie.example');
    const event: any = {
      version: '2.0',
      rawPath: '/api/auth/session',
      headers: { origin: 'https://foreign.example' },
      requestContext: { http: { method: 'OPTIONS' }, requestId: 'test' },
    };
    expect(await handler(event)).toMatchObject({ statusCode: 403 });
    event.headers.origin = 'https://brownie.example';
    event.requestContext.http.method = 'POST';
    expect(await handler(event)).toMatchObject({ statusCode: 401 });
  });
});
