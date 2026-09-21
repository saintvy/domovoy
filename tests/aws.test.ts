import { describe, expect, it } from 'vitest';
import { googleIdentity } from '../src/aws/identity';
import { assertDatabaseName } from '../src/aws/database';
import { retainedBackupKeys } from '../src/aws/maintenance';
describe('AWS trust boundary', () => {
  const now = Date.UTC(2026, 8, 11),
    config = {
      issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/pool',
      clientId: 'client',
    };
  const claims = {
    iss: config.issuer,
    aud: config.clientId,
    sub: 'subject',
    token_use: 'id',
    email: 'Family@Example.test',
    email_verified: 'true',
    identities: JSON.stringify([
      { providerName: 'Google', providerType: 'Google' },
    ]),
    auth_time: Math.floor(now / 1000) - 10,
    exp: Math.floor(now / 1000) + 60,
  };
  it('accepts trusted Cognito Google ID claims and normalizes email', () => {
    expect(googleIdentity(claims, config, now)).toMatchObject({
      subject: 'subject',
      email: 'family@example.test',
    });
  });
  it.each([
    { iss: 'https://attacker.test' },
    { aud: 'other-client' },
    { token_use: 'access' },
    { email_verified: 'false' },
    { identities: '[]' },
    { identities: 'broken' },
    { exp: 0 },
    { auth_time: undefined },
  ])('rejects untrusted claims %j', (change) => {
    expect(() =>
      googleIdentity({ ...claims, ...change }, config, now),
    ).toThrow();
  });
  it('rejects missing authorizer and prevents accidentally targeting wcc database', () => {
    expect(() => googleIdentity(undefined, config, now)).toThrow();
    expect(() => assertDatabaseName('wcc')).toThrow();
    expect(() => assertDatabaseName('postgres')).toThrow();
    expect(() => assertDatabaseName('brownie-prod')).toThrow();
    expect(() => assertDatabaseName('brownie')).not.toThrow();
    expect(() => assertDatabaseName('brownie_test')).not.toThrow();
  });
  it('retains seven recent daily and three monthly representatives', () => {
    const records = Array.from({ length: 10 }, (_, index) => ({
      id: 'sep-' + index,
      created_at: Date.UTC(2026, 8, 11 - index),
    }));
    records.push(
      { id: 'august', created_at: Date.UTC(2026, 7, 31) },
      { id: 'july', created_at: Date.UTC(2026, 6, 31) },
      { id: 'june', created_at: Date.UTC(2026, 5, 30) },
    );
    const keep = retainedBackupKeys(records);
    expect(keep.size).toBe(9);
    expect(keep.has('august')).toBe(true);
    expect(keep.has('july')).toBe(true);
    expect(keep.has('june')).toBe(false);
    expect(keep.has('sep-7')).toBe(false);
  });
});
