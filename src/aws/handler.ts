import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { FamilyApplication } from './families';
import { createDatabase, type Database } from './database';
import { ApiError, check, gatewayGoogleIdentity } from './identity';
import { DomainError } from '../domain';
import { runFamilyMaintenance } from './family-maintenance';
import { productionServices } from './services';

let database: Database | undefined;
const db = () => (database ??= createDatabase());

export async function handler(
  event: APIGatewayProxyEventV2 | { action: 'maintenance' },
): Promise<APIGatewayProxyStructuredResultV2 | unknown> {
  if ('action' in event && event.action === 'maintenance') {
    // API Gateway constructs its event; browser payloads cannot inject top-level action.
    return runFamilyMaintenance(db(), productionServices());
  }
  const request = event as APIGatewayProxyEventV2;
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  try {
    check(
      request.version === '2.0' && request.requestContext?.http,
      'INVALID_GATEWAY_EVENT',
      400,
    );
    const path = request.rawPath,
      method = request.requestContext.http.method;
    const origin = headers.origin;
    // CORS is enforced by API Gateway; also reject an explicitly foreign browser origin.
    check(!origin || origin === process.env.APP_ORIGIN, 'ORIGIN_REJECTED', 403);
    // Explicit OPTIONS integration is unauthenticated; never demand a browser JWT for preflight.
    if (method === 'OPTIONS' && path.startsWith('/api/'))
      return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
    const claims = (
      request.requestContext as typeof request.requestContext & {
        authorizer?: { jwt?: { claims?: Record<string, unknown> } };
      }
    ).authorizer?.jwt?.claims;
    const identity = claims
      ? gatewayGoogleIdentity(claims, headers.authorization, {
          issuer: process.env.COGNITO_ISSUER ?? '',
          clientId: process.env.COGNITO_CLIENT_ID ?? '',
        })
      : undefined;
    check(
      path === '/api/health' || path === '/health' || identity,
      'AUTH_REQUIRED',
      401,
    );
    const raw = request.body
      ? request.isBase64Encoded
        ? Buffer.from(request.body, 'base64').toString('utf8')
        : request.body
      : '{}';
    check(Buffer.byteLength(raw) <= 4 * 1024 * 1024, 'PAYLOAD_TOO_LARGE', 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError('VALIDATION_FAILED');
    }
    check(
      body && typeof body === 'object' && !Array.isArray(body),
      'VALIDATION_FAILED',
    );
    if (path.endsWith('/commands'))
      check(Buffer.byteLength(raw) <= 1024 * 1024, 'PAYLOAD_TOO_LARGE', 413);
    const application = new FamilyApplication(db(), productionServices());
    const result = await application.handle({
      path,
      method,
      identity,
      token: headers['x-brownie-session'],
      body: body as Record<string, any>,
    });
    const encoded = JSON.stringify(result);
    check(
      Buffer.byteLength(encoded) <= 5 * 1024 * 1024,
      'RESPONSE_TOO_LARGE',
      413,
    );
    return response(encoded, 200);
  } catch (error) {
    const status =
      error instanceof ApiError
        ? error.status
        : error instanceof DomainError
          ? 400
          : 503;
    const code =
      error instanceof ApiError || error instanceof DomainError
        ? error.code
        : 'DATABASE_OR_STORAGE_UNAVAILABLE';
    // Database errors and connection parameters are deliberately excluded from public responses/logs.
    return response(
      JSON.stringify({
        error: {
          code,
          message:
            error instanceof DomainError || error instanceof ApiError
              ? error.message
              : code,
        },
        requestId: request.requestContext?.requestId,
      }),
      status,
    );
  }
}
function response(
  body: string,
  statusCode: number,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    body,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  };
}
