import { createHash, randomBytes } from 'node:crypto';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status = 400,
    message = code,
  ) {
    super(message);
  }
}
export function check(
  value: unknown,
  code: string,
  status = 400,
): asserts value {
  if (!value) throw new ApiError(code, status);
}
export interface Identity {
  subject: string;
  email: string;
  name: string;
  authenticatedAt: number;
}
export interface AuthConfig {
  issuer: string;
  clientId: string;
}
/** Only call with verified claims: from the gateway adapter below or a JWT verifier. */
export function googleIdentity(
  claims: Record<string, unknown> | undefined,
  config: AuthConfig,
  now = Date.now(),
): Identity {
  check(
    claims &&
      claims.iss === config.issuer &&
      claims.aud === config.clientId &&
      claims.token_use === 'id',
    'AUTH_REQUIRED',
    401,
  );
  check(
    typeof claims.sub === 'string' &&
      claims.sub.length > 0 &&
      Number(claims.exp) * 1000 > now,
    'AUTH_REQUIRED',
    401,
  );
  check(
    claims.email_verified === true || claims.email_verified === 'true',
    'VERIFIED_EMAIL_REQUIRED',
    403,
  );
  check(
    typeof claims.email === 'string' &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email),
    'VERIFIED_EMAIL_REQUIRED',
    403,
  );
  let identities: unknown;
  try {
    identities =
      typeof claims.identities === 'string'
        ? JSON.parse(claims.identities)
        : claims.identities;
  } catch {
    identities = undefined;
  }
  check(
    Array.isArray(identities) &&
      identities.some(
        (identity) =>
          identity?.providerName === 'Google' &&
          identity?.providerType === 'Google',
      ),
    'GOOGLE_LOGIN_REQUIRED',
    403,
  );
  check(
    Number.isFinite(Number(claims.auth_time)) && Number(claims.auth_time) > 0,
    'AUTH_REQUIRED',
    401,
  );
  return {
    subject: claims.sub,
    email: claims.email.toLowerCase(),
    name: String(claims.name ?? claims.email).slice(0, 100),
    authenticatedAt: Number(claims.auth_time),
  };
}

/** API Gateway has already verified the Authorization JWT's signature, issuer and audience.
 * Its integration event stringifies structured claims (not necessarily as JSON). Restore
 * the original payload from that SAME header, bound to the trusted scalar claims. This is
 * not a JWT verifier and MUST NOT be used on routes without a gateway JWT authorizer.
 * Local development uses CognitoJwtVerifier instead. Never log the header or payload.
 */
export function gatewayGoogleIdentity(
  claims: Record<string, unknown> | undefined,
  authorization: string | undefined,
  config: AuthConfig,
  now = Date.now(),
): Identity {
  check(claims, 'AUTH_REQUIRED', 401);
  check(
    typeof authorization === 'string' && authorization.length <= 32768,
    'AUTH_REQUIRED',
    401,
  );
  const match =
    /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(
      authorization,
    );
  check(match, 'AUTH_REQUIRED', 401);
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
  } catch {
    throw new ApiError('AUTH_REQUIRED', 401);
  }
  check(
    payload && typeof payload === 'object' && !Array.isArray(payload),
    'AUTH_REQUIRED',
    401,
  );
  // In particular, a body/header alone can never supply the authorizer context.
  for (const key of [
    'iss',
    'aud',
    'sub',
    'token_use',
    'exp',
    'auth_time',
    'email',
    'email_verified',
  ]) {
    const trusted = claims[key],
      original = payload[key];
    check(
      ['string', 'number', 'boolean'].includes(typeof trusted) &&
        ['string', 'number', 'boolean'].includes(typeof original) &&
        String(trusted) === String(original),
      'AUTH_REQUIRED',
      401,
    );
  }
  return googleIdentity(payload, config, now);
}
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const sessionToken = () =>
  Buffer.from(randomBytes(32)).toString('base64url');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ':' +
            canonical((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
