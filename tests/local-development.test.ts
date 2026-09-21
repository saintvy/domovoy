import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import {
  validateLocalDatabaseUrl,
  validateLocalPublicConfig,
} from '../scripts/local-config';
import { createLocalIdentityVerifier } from '../scripts/local-jwt';
import { openLocalPostgres } from '../scripts/local-postgres';
import { FamilyApplication } from '../src/aws/families';

const config = {
  apiBaseUrl: '/api',
  cognitoDomain: 'https://brownie-test.auth.eu-central-1.amazoncognito.com',
  cognitoClientId: 'localclient',
  cognitoUserPoolId: 'eu-central-1_LocalTests',
  cognitoRedirectUri: 'http://127.0.0.1:5173/',
  region: 'eu-central-1',
} as const;
afterEach(() => vi.restoreAllMocks());
it('only accepts the dedicated loopback database and never cloud DSNs', () => {
  expect(
    validateLocalDatabaseUrl(
      'postgresql://brownie_local:password@127.0.0.1:5434/brownie_local',
    ),
  ).toContain('127.0.0.1');
  for (const bad of [
    'postgresql://brownie_local:password@db.rds.amazonaws.com:5434/brownie_local',
    'postgresql://brownie_local:password@127.0.0.1:5434/witcher',
    'postgresql://master:password@127.0.0.1:5434/brownie_local',
    'postgresql://brownie_local:password@127.0.0.1:5434/brownie_local?host=other',
  ])
    expect(() => validateLocalDatabaseUrl(bad)).toThrow();
});
it('publishes only allowlisted public configuration and rejects a cloud API or wrong callback', () => {
  const value = validateLocalPublicConfig({
    ...config,
    clientSecret: 'must-not-publish',
    password: 'must-not-publish',
  });
  expect(value).toEqual(config);
  expect(JSON.stringify(value)).not.toContain('must-not-publish');
  expect(() =>
    validateLocalPublicConfig({
      ...config,
      apiBaseUrl: 'https://production.example/api',
    }),
  ).toThrow();
  expect(() =>
    validateLocalPublicConfig({
      ...config,
      cognitoRedirectUri: 'https://production.example/',
    }),
  ).toThrow();
  expect(() =>
    validateLocalPublicConfig({
      ...config,
      cognitoDomain: 'http://attacker.test',
    }),
  ).toThrow();
});
it('cryptographically verifies Google Cognito tokens and rejects forged/expired/wrong-client/non-Google tokens', async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...keys.publicKey.export({ format: 'jwk' }),
    kty: 'RSA',
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
  const original = CognitoJwtVerifier.create.bind(CognitoJwtVerifier);
  // Only the test JWKS transport is replaced. Production has no test-key or identity bypass.
  vi.spyOn(CognitoJwtVerifier, 'create').mockImplementation(((
    properties: any,
  ) => {
    const verifier = original(properties);
    verifier.cacheJwks({ keys: [jwk] });
    return verifier;
  }) as typeof CognitoJwtVerifier.create);
  const verify = createLocalIdentityVerifier(config),
    now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:
      'https://cognito-idp.eu-central-1.amazonaws.com/' +
      config.cognitoUserPoolId,
    aud: config.cognitoClientId,
    token_use: 'id',
    sub: 'google-user',
    exp: now + 300,
    iat: now,
    auth_time: now,
    email: 'test@example.com',
    email_verified: true,
    identities: [{ providerName: 'Google', providerType: 'Google' }],
  };
  function jwt(overrides: Record<string, unknown> = {}, forged = false) {
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test-key' }),
    ).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({ ...claims, ...overrides }),
    ).toString('base64url');
    return (
      header +
      '.' +
      body +
      '.' +
      (forged
        ? Buffer.alloc(256).toString('base64url')
        : sign(
            'RSA-SHA256',
            Buffer.from(header + '.' + body),
            keys.privateKey,
          ).toString('base64url'))
    );
  }
  await expect(verify('Bearer ' + jwt())).resolves.toMatchObject({
    subject: 'google-user',
    email: 'test@example.com',
  });
  await expect(verify(undefined)).rejects.toMatchObject({
    code: 'AUTH_REQUIRED',
  });
  await expect(verify('Bearer ' + jwt({}, true))).rejects.toMatchObject({
    code: 'AUTH_REQUIRED',
  });
  await expect(verify('Bearer ' + jwt({ exp: now - 1 }))).rejects.toMatchObject(
    { code: 'AUTH_REQUIRED' },
  );
  await expect(
    verify('Bearer ' + jwt({ aud: 'another-client' })),
  ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  await expect(
    verify('Bearer ' + jwt({ email_verified: false })),
  ).rejects.toMatchObject({ code: 'VERIFIED_EMAIL_REQUIRED' });
  await expect(
    verify('Bearer ' + jwt({ identities: [] })),
  ).rejects.toMatchObject({ code: 'GOOGLE_LOGIN_REQUIRED' });
}, 15000);
it.skipIf(process.env.BROWNIE_TEST_DOCKER !== '1')(
  'real Docker PostgreSQL retains a family across pool restart and scopes it to its identity',
  async () => {
    const identity = {
      subject: 'local-sql-test-' + randomUUID(),
      email: randomUUID() + '@example.test',
      name: 'Test account',
      authenticatedAt: Math.floor(Date.now() / 1000),
    };
    let local = await openLocalPostgres(),
      familyId: string | undefined;
    try {
      let app = new FamilyApplication(local.database, {
        appOrigin: 'http://127.0.0.1:5173',
      });
      const created = await app.handle({
        path: '/families',
        method: 'POST',
        identity,
        body: {
          name: 'Docker persistence',
          currency: 'EUR',
          timezone: 'Europe/Prague',
          locale: 'en',
        },
      });
      const first = await app.handle({
        path: '/state',
        method: 'GET',
        identity,
        token: created.sessionToken,
      });
      familyId = first.state.household.id;
      await app.handle({
        path: '/commands',
        method: 'POST',
        identity,
        token: created.sessionToken,
        body: {
          protocolVersion: 1,
          operationId: randomUUID(),
          instanceGeneration: first.instanceGeneration,
          expectedRevision: first.revision,
          commands: [
            {
              type: 'AddPerson',
              payload: { id: randomUUID(), displayName: 'Persisted in Docker' },
            },
          ],
        },
      });
      await local.close();
      local = await openLocalPostgres();
      app = new FamilyApplication(local.database, {
        appOrigin: 'http://127.0.0.1:5173',
      });
      const reread = await app.handle({
        path: '/state',
        method: 'GET',
        identity,
        token: created.sessionToken,
      });
      expect(
        reread.state.people.some(
          (person: any) => person.displayName === 'Persisted in Docker',
        ),
      ).toBe(true);
      await expect(
        app.handle({
          path: '/state',
          method: 'GET',
          identity: {
            ...identity,
            subject: 'unknown-' + randomUUID(),
            email: randomUUID() + '@example.test',
          },
          token: created.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'FAMILY_REQUIRED' });
    } finally {
      await local.database.transaction(async (c) => {
        if (familyId)
          await c.query('DELETE FROM brownie_families WHERE id=$1', [familyId]);
        await c.query('DELETE FROM brownie_accounts WHERE subject=$1', [
          identity.subject,
        ]);
      });
      await local.close();
    }
  },
  30000,
);
