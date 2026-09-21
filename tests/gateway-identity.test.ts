import { describe, expect, it } from 'vitest';
import { gatewayGoogleIdentity } from '../src/aws/identity';

const now = Date.UTC(2026, 8, 16);
const config = {
  issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/pool',
  clientId: 'production-client',
};
const payload = {
  iss: config.issuer,
  aud: config.clientId,
  sub: 'cognito-subject',
  token_use: 'id',
  exp: now / 1000 + 900,
  auth_time: now / 1000 - 10,
  email: 'member@example.com',
  email_verified: true,
  name: 'Member',
  identities: [
    {
      providerName: 'Google',
      providerType: 'Google',
      userId: '123',
      primary: true,
    },
  ],
};
// Signature verification belongs to API Gateway, outside this adapter's unit boundary.
const header = (body: unknown) =>
  'Bearer ' +
  Buffer.from('{"alg":"RS256"}').toString('base64url') +
  '.' +
  Buffer.from(JSON.stringify(body)).toString('base64url') +
  '.gatewayVerifiedSignature';
const claims = Object.fromEntries(
  Object.entries(payload).map(([key, value]) => [key, String(value)]),
);

describe('Gateway verified Google identity', () => {
  it.each([
    '[{userId=123, providerName=Google, providerType=Google, primary=true}]',
    '[object Object]',
    undefined,
  ])(
    'handles lossy structured claims without relaxing the Google requirement (%s)',
    (identities) => {
      expect(
        gatewayGoogleIdentity(
          { ...claims, identities },
          header(payload),
          config,
          now,
        ),
      ).toEqual({
        subject: payload.sub,
        email: payload.email,
        name: payload.name,
        authenticatedAt: payload.auth_time,
      });
    },
  );
  it('does not accept a browser token without a trusted authorizer context', () => {
    expect(() =>
      gatewayGoogleIdentity(undefined, header(payload), config, now),
    ).toThrow('AUTH_REQUIRED');
  });
  it.each([
    'iss',
    'aud',
    'sub',
    'token_use',
    'exp',
    'auth_time',
    'email',
    'email_verified',
  ])('rejects a header/context mismatch in %s', (key) => {
    expect(() =>
      gatewayGoogleIdentity(
        claims,
        header({ ...payload, [key]: 'foreign' }),
        config,
        now,
      ),
    ).toThrow('AUTH_REQUIRED');
  });
  it.each([
    {},
    { identities: [] },
    { identities: [{ providerName: 'Google', providerType: 'OIDC' }] },
  ])('requires a genuine Google provider in the verified payload', (change) => {
    const original = { ...payload, identities: undefined, ...change };
    expect(() =>
      gatewayGoogleIdentity(claims, header(original), config, now),
    ).toThrow('GOOGLE_LOGIN_REQUIRED');
  });
  it('still rejects an expired token, wrong audience and an access token', () => {
    for (const change of [
      { exp: now / 1000 - 1 },
      { aud: 'local-client' },
      { token_use: 'access' },
    ]) {
      const original = { ...payload, ...change };
      expect(() =>
        gatewayGoogleIdentity(
          { ...claims, ...change },
          header(original),
          config,
          now,
        ),
      ).toThrow('AUTH_REQUIRED');
    }
  });
  it.each([
    undefined,
    '',
    'Bearer bad',
    'Bearer a.bnVsbA.c',
    header(payload) + ', another-token',
  ])('rejects absent/malformed headers (%s)', (authorization) => {
    expect(() =>
      gatewayGoogleIdentity(claims, authorization, config, now),
    ).toThrow('AUTH_REQUIRED');
  });
});
