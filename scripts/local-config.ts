import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const localOrigin = 'http://127.0.0.1:5173';
export interface LocalPublicConfig {
  apiBaseUrl: '/api';
  cognitoDomain: string;
  cognitoClientId: string;
  cognitoUserPoolId: string;
  cognitoRedirectUri: string;
  region: string;
}
export function validateLocalPublicConfig(value: unknown): LocalPublicConfig {
  if (!value || typeof value !== 'object')
    throw new Error(
      'Configure infra/runtime-config.local.json for Google login.',
    );
  const v = value as Record<string, unknown>;
  if (v.apiBaseUrl !== '/api')
    throw new Error(
      'Local apiBaseUrl must be /api; cloud database requests are forbidden.',
    );
  if (
    typeof v.region !== 'string' ||
    typeof v.cognitoUserPoolId !== 'string' ||
    !v.cognitoUserPoolId.startsWith(v.region + '_')
  )
    throw new Error('Local Cognito region/user pool are missing.');
  if (typeof v.cognitoClientId !== 'string' || !v.cognitoClientId)
    throw new Error('Local Cognito app client is missing.');
  if (v.cognitoRedirectUri !== localOrigin + '/')
    throw new Error('Local Cognito callback must be ' + localOrigin + '/');
  if (typeof v.cognitoDomain !== 'string')
    throw new Error('Local Cognito domain is missing.');
  const domain = new URL(v.cognitoDomain);
  if (
    domain.protocol !== 'https:' ||
    !domain.hostname.endsWith('.amazoncognito.com') ||
    domain.username ||
    domain.password ||
    domain.search ||
    domain.hash
  )
    throw new Error('Use a trusted HTTPS Cognito hosted domain.');
  return {
    apiBaseUrl: '/api',
    cognitoDomain: domain.origin,
    cognitoClientId: v.cognitoClientId,
    cognitoUserPoolId: v.cognitoUserPoolId,
    cognitoRedirectUri: v.cognitoRedirectUri,
    region: v.region,
  };
}
export function loadLocalPublicConfig(
  file = resolve('infra/runtime-config.local.json'),
) {
  return validateLocalPublicConfig(JSON.parse(readFileSync(file, 'utf8')));
}
export function loadLocalEnvironment(
  file = resolve('.env.local'),
): Record<string, string> {
  return existsSync(file)
    ? Object.fromEntries(
        Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
}
export function validateLocalDatabaseUrl(value: string | undefined) {
  if (!value)
    throw new Error(
      'Run node scripts/dev-db.mjs up to create the Docker database settings.',
    );
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    url.hostname !== '127.0.0.1' ||
    url.port !== '5434' ||
    url.pathname !== '/brownie_local' ||
    url.username !== 'brownie_local' ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Local SQL must use brownie_local at 127.0.0.1:5434. RDS endpoints are forbidden.',
    );
  return value;
}
