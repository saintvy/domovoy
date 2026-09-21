# Local development

The development API uses real Google authentication through Cognito and a
dedicated Docker PostgreSQL 16 database. It never connects to production RDS.
Internet access is required for Google sign-in, Cognito JWKS and ECB rates.

## Prerequisites

- Node.js 22.20 or newer; `.nvmrc` contains the CI version.
- Docker Engine with Compose v2, or Docker Desktop using Linux containers.
- A Cognito public app client with Google as its only identity provider.

Run `npm ci`. You can run `npm run build`, `npm run test:quick` and the browser
tests without real cloud credentials. `npm run dev:client` displays the sign-in
screen without a database; authenticated development requires the setup below.

## Configure Google sign-in

Create a separate public Cognito app client for localhost, with no client secret.
Enable authorization code flow and the `openid email profile` scopes. Register
`http://127.0.0.1:5173/` as both callback and logout URL.

The Google OAuth web client redirects to
`https://<domain>.auth.<region>.amazoncognito.com/oauth2/idpresponse`.
The localhost callback is registered on the Cognito client, not substituted for
Google's Cognito callback. End users do not need to create API keys.

Copy `infra/runtime-config.example.json` to `infra/runtime-config.local.json` and
replace the placeholder public identifiers. Keep `apiBaseUrl` as `/api` and the
callback exactly `http://127.0.0.1:5173/`. Vite exposes only the allowed public fields.
Never add AWS credentials, a Google client secret or a database password.

## Start the application

```sh
npm ci
npm run dev
```

The script checks ports, generates missing credentials in ignored `.env.local`,
starts PostgreSQL and waits for its health check, then starts Vite and the API.
On Windows it can start Docker Desktop in the background if needed.

| Service                     | Address                  |
| --------------------------- | ------------------------ |
| Frontend and OAuth callback | `http://127.0.0.1:5173/` |
| API                         | `http://127.0.0.1:8787/` |
| PostgreSQL                  | `127.0.0.1:5434`         |

Open the exact frontend address and sign in with Google. A new account sees the
normal create-family or invitation flow. Local and hosted households are independent.
The local API verifies the JWT signature, issuer, audience, token type, expiry and
Google identity, then checks SQL membership and the family session.

## Local data

| Data                                       | Location                          |
| ------------------------------------------ | --------------------------------- |
| PostgreSQL volume                          | `brownie-local_brownie-postgres`  |
| Database and SQL user                      | `brownie_local`                   |
| Database password, URL and maintenance key | `.env.local`                      |
| Public authentication settings             | `infra/runtime-config.local.json` |
| Financial backups                          | `tmp/local-backups/<family-id>/`  |
| Browser drafts                             | IndexedDB for the current origin  |

Historical storage identifiers are retained for compatibility. Do not replace the
password of an existing Docker volume by editing `.env.local`: PostgreSQL uses
`POSTGRES_PASSWORD` during initialization, not on every start. Use an explicit
database password recovery procedure if credentials are lost.

The database allowlist accepts only the dedicated database/user on
`127.0.0.1:5434`, with no URL query or fragment. RDS endpoints are rejected before
connecting. Plain SQL transport is allowed only in this loopback environment.

## Stop and resume

Ctrl+C stops Vite and the API. PostgreSQL stays running and retains its volume.

```sh
node scripts/dev-db.mjs status
node scripts/dev-db.mjs down
node scripts/dev-db.mjs up
```

`down` stops the service; it does not remove the volume. Use `npm run dev` for the
next full session. If a port is occupied, stop the earlier process before restarting.

## Maintenance, rates and email

While the local API runs, it executes family maintenance every minute. To run it
immediately, use `npm run dev:maintenance`. The endpoint requires the local
maintenance key, which is never sent to the browser. Each run handles a bounded
batch of families. Missed automatic payments are processed when maintenance resumes.

The local rate adapter downloads ECB history directly and caches it in memory
for one hour. It uses the shared conversion rules, without the production S3
refresh trigger. An unavailable rate fails explicitly; there is no hidden 1:1 fallback.

Local invitation delivery is not configured. `INVITATION_EMAIL_NOT_CONFIGURED`
is an expected limitation until a local email adapter is implemented.

## Real PostgreSQL test

Start the database, then opt in to the integration test. In PowerShell:

```powershell
node scripts/dev-db.mjs up
$env:BROWNIE_TEST_DOCKER = '1'
npx vitest run tests/local-development.test.ts
Remove-Item Env:BROWNIE_TEST_DOCKER
```

On a POSIX shell:

```sh
node scripts/dev-db.mjs up
BROWNIE_TEST_DOCKER=1 npx vitest run tests/local-development.test.ts
```

The test creates randomly identified fixtures and cleans up its own records. It
checks persistence across pool restarts and access isolation. Without the opt-in,
only this integration case is skipped. CI starts a disposable local database and
enables it explicitly.

## Troubleshooting

| Symptom                        | Check                                                                 |
| ------------------------------ | --------------------------------------------------------------------- |
| Docker unavailable             | Engine readiness, Linux containers and WSL2/virtualization on Windows |
| Port in use                    | Existing development processes or another database service            |
| Password authentication failed | Existing volume credentials match `.env.local`                        |
| Missing runtime configuration  | Copy the example and configure a real public Cognito client           |
| `redirect_uri_mismatch`        | Exact callback in Cognito and local configuration                     |
| `AUTH_REQUIRED`                | JWT expiry, pool/client IDs and API access to Cognito JWKS            |
| `Failed to fetch`              | API health, origin and network access to Cognito                      |
| `EXCHANGE_RATE_REQUIRED`       | ECB has a supported quotation for the currency and date               |
| `EXCHANGE_SOURCE_UNAVAILABLE`  | Retry once the rate source is reachable                               |

Browser OAuth tests check the redirect contract with intercepted responses; they
do not prove a completed real Google consent and callback flow.
