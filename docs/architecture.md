# Architecture

Domovoy separates financial rules, browser interaction and server authority.
The deployment targets private household data shared by multiple accounts and devices.

## Layers

| Layer          | Responsibilities                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| Domain         | Pure commands, recurrence, money invariants, allocations, refunds and validation |
| Client         | React views, OAuth PKCE, family-scoped drafts, revision conflicts and reports    |
| Family API     | Identity, membership, permissions, SQL transactions and command receipts         |
| Services       | Backup storage, invitations, exchange rates and scheduled maintenance            |
| Infrastructure | Explicit account boundaries, private networking and deployment artifacts         |

`src/aws/handler.ts` serves the production API. `scripts/dev-api.ts` uses the same
`FamilyApplication` against local PostgreSQL, with cryptographic Cognito JWT
verification. PGlite and synthetic identities are confined to test fixtures.

## Write consistency

The client submits an operation ID, protocol version, instance generation,
expected revision and command batch. The server derives the actor from verified
identity and session data, locks the account and family, and rechecks membership.

An existing receipt with the same actor and request hash returns its prior result.
A reused ID with different content is rejected. A new command must match the
current generation and revision. Validation, financial state, audit information
and the receipt are committed together; a failure rolls the transaction back.

Concurrent edits therefore produce a revision conflict rather than a silent
overwrite. The client retains the draft for review. A timeout may follow a
successful commit, so retries reuse the same operation ID and payload.

## Data and money

Each family currently has a complete financial JSONB snapshot. Accounts,
memberships, sessions, invitations, receipts and security audit records live in
separate SQL tables. Money uses integer minor units; conversion preserves the
original amounts and records the rate source and date.

This representation keeps domain validation and atomic changes understandable,
but requires full-state loading and validation. Requests within a family
serialize. The next scaling step is targeted SQL reads and writes, shorter
transactions and measurements of memory and end-to-end latency.

## Authentication and authorization

Google is the only identity provider, federated through Cognito. Public browser
clients use authorization code flow with PKCE, state and nonce. Production API
Gateway validates JWTs; the API also checks identity claims against its trusted
authorizer context. Local development verifies signatures through Cognito JWKS.

A separate hashed family session is bound to the Google subject, membership and
session generation. Roles and immutable record authorship are checked on the
server. Refreshing a JWT cannot revive a revoked family session.

ID and refresh tokens live in the current tab's `sessionStorage`, outside financial
IndexedDB data and reports. This makes XSS prevention essential and does not
promise persistence after a tab closes. The PWA caches its static shell, not
authenticated API responses or runtime configuration.

## AWS topology and tradeoffs

CloudFront serves a private S3 site and routes the API to API Gateway. The main
Lambda runs in isolated subnets and reaches an existing PostgreSQL 16 RDS instance
through same-region, cross-account VPC peering. It has a dedicated database and
restricted runtime login, with TLS certificate verification.

An S3 gateway endpoint provides private access to backups, annual ECB rate files
and the invitation outbox. Separate workers outside the VPC fetch ECB data and
send SES email. Their separation prevents an email backlog from delaying rate
updates; neither worker has SQL access. EventBridge drives maintenance and rate refreshes.

Telegram reminders use a separate private SQL bridge, durable report jobs and
opaque S3 wakeups. An internet-capable worker claims a freshly validated report
through a narrowly scoped IAM invocation, calls Telegram, and records the result
through the same bridge. It has no database configuration. An authenticated
Telegram webhook consumes expiring account-link tokens through that bridge.
Bot and webhook credentials are SSM Parameter Store SecureStrings; only parameter
names enter the worker environment. See [Telegram reminders](telegram-reminders.md)
for scheduling, delivery ambiguity and rollout requirements.

The templates create no RDS instance, NAT gateway, EC2 instance or RDS proxy.
This reduces standing infrastructure but requires an existing database account,
explicit peering, capacity planning and selective recovery for the shared RDS host.
Some S3 calls occur while SQL transactions are open; shortening those transactions
is a documented improvement area.

## Compatibility

Domovoy was previously developed under the internal name Brownie. Existing
`brownie_*` SQL tables, database/login names, `X-Brownie-Session`, browser storage
keys, backup format identifiers and `Brownie*` CloudFormation stack IDs remain
stable. The `wcc*` configuration fields identify the account hosting the existing
database; they are historical field names, not credentials or a required project name.

Renaming these contracts requires explicit migrations and a deployment plan.
The repository name, package metadata and public documentation use Domovoy.
The singleton schema initialization and migration code remain because existing
installations can still require them. Unused password/TOTP authentication and the
unused manual-rate UI have been removed.
