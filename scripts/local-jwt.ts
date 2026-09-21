import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { ApiError, googleIdentity } from '../src/aws/identity';
import type { LocalPublicConfig } from './local-config';
/** Real signature verification. No fake identity, test keys, or environment bypass. */
export function createLocalIdentityVerifier(config: LocalPublicConfig) {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.cognitoUserPoolId,
    clientId: config.cognitoClientId,
    tokenUse: 'id',
  });
  const issuer =
    'https://cognito-idp.' +
    config.region +
    '.amazonaws.com/' +
    config.cognitoUserPoolId;
  return async (authorization: string | undefined) => {
    if (!authorization?.startsWith('Bearer '))
      throw new ApiError('AUTH_REQUIRED', 401);
    let claims;
    try {
      claims = await verifier.verify(authorization.slice(7));
    } catch {
      throw new ApiError('AUTH_REQUIRED', 401);
    }
    return googleIdentity(claims, { issuer, clientId: config.cognitoClientId });
  };
}
