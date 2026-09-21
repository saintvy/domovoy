# Domovoy product specification

Product baseline: specification 3.2, incorporating the updates through
21 September 2026. This document defines required behavior; a requirement is
not evidence of implementation or deployment. See [status](implementation-status.md),
[verification](verification.md) and the [changelog](../CHANGELOG.md).

## 1. Purpose and boundaries

Domovoy helps a family account for subscriptions, rent, utilities and other
recurring commitments across devices. Charges, payments, allocations, refunds
and outstanding balances are distinct records.

- Google is the only sign-in method. There are no application passwords or demo login.
- An account belongs to at most one family; the server isolates families.
- Each active family has exactly one head. A person may exist without an account.
- PostgreSQL holds confirmed data; closing a tab or using another device must not lose a committed record.
- Original money and history must not be silently replaced by another amount or currency.
- Automatic payments are accounting entries, not bank transactions.
- User exports are reports; backup and restoration are operator responsibilities.

Bank integrations, card details, provider passwords, contract cancellation and
general-purpose accounting are outside the current scope. Serverless deployment
and reuse of an existing database reduce standing resources but do not promise free AWS usage.

## 2. Architecture and environments

CloudFront serves static assets from private S3. Google authenticates through
Cognito. API Gateway verifies JWTs and routes to a Lambda in isolated application
subnets. Cross-account VPC peering connects it to a dedicated database on an
existing PostgreSQL 16 RDS instance. An S3 gateway endpoint gives private access
to financial backups, rate files and an email outbox.

Separate workers outside the VPC handle SES invitations and ECB rates, without
SQL access or public Function URLs. Separating them prevents an email backlog
from delaying rates. EventBridge runs family maintenance and scheduled rate refreshes.
The topology needs no new RDS, NAT gateway, EC2 instance, RDS proxy, ALB or paid
interface endpoint. Shared RDS capacity and recovery remain dependencies.

Peered CIDRs must not overlap. Routes and security groups allow the required
PostgreSQL connection, using TLS with certificate verification. The runtime SQL
login has no master or DDL privileges and no access to other applications' data.
Schema ownership and temporary migration privileges remain separate.

Deployment verifies account IDs and uses explicit profiles. Secrets stay outside
Git, public configuration, logs and shell arguments. The static site contains no secrets.

Local development uses genuine Cognito sign-in and Docker PostgreSQL at
`127.0.0.1:5434`, API port 8787 and Vite port 5173. A strict database URL allowlist
rejects production RDS. The localhost Cognito app client is public, has no secret
and uses its own callback. PGlite and fake identities are test-only. Missing local
email support must produce an explicit unavailable result, not a delivery claim.

## 3. Identity, families and permissions

### Authentication and sessions

Use authorization code flow with PKCE S256, single-use state and nonce, a fixed
callback and Google as the sole provider. API Gateway verifies JWT signature,
issuer, audience and expiry. The API also requires `token_use=id`, a valid subject,
verified email and Google identity. Decoding a JWT is not verification.

The authorizer reads `Authorization`. When nested claims are transformed in the
gateway event, recover them only from that same verified token and compare issuer,
audience, subject, token type, expiry, authentication time and email claims with
the trusted gateway context. Requests without that context are not authorized.
The local API verifies the signature independently through Cognito JWKS.

ID tokens last 15 minutes; refresh tokens may last up to 30 days. Store them in
tab `sessionStorage`, separately from financial IndexedDB data and backups.
Refresh near-expiry tokens before requests and share one refresh among concurrent
requests. Logout clears tokens and attempts refresh-token revocation; a late
refresh must not restore a logged-out session. Network failure must not erase drafts.
Token lifetime does not guarantee sign-in after tab closure or access revocation.

Family requests also carry a random `X-Brownie-Session`. SQL stores its hash,
subject, family, generation, timestamps and revocation. A foreign JWT cannot use
it. Valid sessions slide to 12 hours when less than six remain, only after checking
membership and generation. Expired/revoked sessions are not renewed by JWT refresh.
Tokens never enter financial caches, exports or logs. JavaScript token access
requires XSS protection.

### Membership and roles

An account without a family may create one or accept an invitation. Creation
makes the account the sole head and creates its person record. A fixed bootstrap
email is not the access model. A person needs only a name; email, color and access
are separate. Invitation acceptance links an existing person rather than creating a duplicate.

Membership uniqueness by Google subject enforces one family even under concurrent
requests. The API derives the family from membership rather than trusting a supplied ID.

| Role         | Permission                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `admin`      | Full financial and family management, people, invitations, roles, head transfer and session revocation |
| `observer`   | Read the financial register, including amounts                                                         |
| `editor`     | Read and create; cannot change or delete existing records, including their own                         |
| `own_editor` | Create and change/delete their own records within permitted commands                                   |
| `deleter`    | Change records by any author; cannot manage the family or perform full obligation cascade deletion     |

Obligations, payments and automatic schedules have immutable `createdByUserId`
assigned by the server. Old records with unknown authors may be changed only by
`admin` or `deleter`. Creating a payment does not require owning its obligation;
editing/refunding it checks the payment author. Lifecycle edits must not indirectly
change another author's payments or schedules. Full cascade deletion is admin-only.
Role changes and membership removal revoke the affected family sessions.

### Invitations

The head selects an existing eligible person, email and role. Tokens have at least
256 random bits, expire after seven days and are single-use. SQL stores their hash.
Links carry tokens in the fragment; the private S3 outbox temporarily contains the
full link for delivery and requires scoped access and cleanup.

Acceptance atomically checks token validity, matching verified Google email, no
other-family membership and an unlinked person. There is no automatic transfer
between families. Pending invitation roles may change without creating membership.
Head status can only be transferred to a confirmed member by the current head;
the admin option is listed first but disabled for an unconfirmed email.

A new invitation for the same email/person revokes the previous one. Revoked,
expired or already-used tokens give no access. The initial sending limit is 20
invitations per family per day. Queuing is not delivery; retries may resend the same
token. SES sender verification and applicable recipient restrictions must be satisfied.

### Leaving a family

Leaving requires confirmation and removes access, preserving the person's financial
history while the family remains. The head may transfer authority explicitly.
If the head leaves without a transfer, choose a new head randomly among remaining
account holders. People without accounts are ineligible. With no accounts left,
close access immediately and clean data asynchronously. There is no seven-day undo window.

## 4. Domain model

IDs are stable and references are validated. Money is a safe integer in minor
currency units. Accounting dates are ISO dates in the household timezone;
technical timestamps are UTC instants.

| Entity                         | Key information                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Household                      | Name, base/additional currencies, timezone, locale and shared color                    |
| Person                         | Name, color and archive state; optional account association                            |
| Account / Membership           | Google subject, verified email, family, person and role                                |
| Provider                       | Name, category and website                                                             |
| Obligation                     | Provider, title, optional responsible person, beneficiaries, icon, dates and lifecycle |
| BillingRule                    | Effective date, recurrence, anchor, due offset, amount/currency and grace days         |
| BillingPeriod                  | Service interval, due date, original charge, base valuation, confirmation or waiver    |
| Payment                        | Payment date, original money, payer, obligation, source, valuation and rate            |
| Allocation                     | Payment-to-period link, base coverage and original-money share                         |
| Refund                         | Original payment, date, positive returned amount, valuation and reason                 |
| AutomaticPaymentSchedule / Run | Obligation, payer, optional money, effective dates and processed-period receipt        |
| ExchangeRate                   | Currency pair, date, decimal rate and source                                           |
| Operation / Audit              | Actor, operation ID, request hash, revision, server time and action                    |
| ServiceAccount / Entitlement   | Domain service metadata; no provider passwords                                         |

## 5. Billing and money

### Obligations and prices

The optional responsible person is independent of beneficiaries: one person, an
explicit group or the entire household. Assigning responsibility does not change
beneficiaries. Seat counts are not the primary way users describe shared benefit.

Support weekly, monthly, quarterly and yearly recurrence. Preserve calendar anchors:
31 January becomes the last day of February and then 31 March; a leap-day annual
anchor becomes 28 February in other years. Service intervals are `[start, end)`;
due dates use a separate calendar-day offset. Overdue begins after `dueDate + graceDays`.

An end date stops new periods but preserves existing debt. Archiving does not cancel
a provider contract. Deterministic period IDs make generation repeatable without
duplicates. Price changes create rule versions and require previews when affecting
future periods or boundaries. No automatic prorating is assumed.

A new price starts at a selected unpaid period or future boundary and updates
subsequent open periods, including already-generated ones. Preserve periods with
allocation history, even cancelled allocations, waivers or completed automatic
runs. A protected selected period cannot change. Preview changed/preserved periods
and superseded future prices. Reject recurrence incompatible with existing intervals.
Use server rates for valuations and normal rules for allocating free credit.

Price history shows a chart followed by dated rule versions, currencies and cadence.
Plot currencies separately. Superseded rules remain in history and paid periods
keep their original references. Amounts can be fixed, confirmed-variable or estimates.
An estimate is not a confirmed payment; a waiver requires a separate reasoned action.

### Date changes, archiving and deletion

Preview deleted/created/preserved periods and affected payments. For payments
outside a new term, require an explicit policy: delete, move within the term, or
keep as credit. Moving revalues at the new date and cannot move a payment after an
existing refund. A payment shared with another obligation cannot be deleted or
moved as part of one obligation; block the change or use an allowed credit policy.

Archiving uses the same algorithm. Ending before the start means cancellation
before commencement, never a negative interval; no payment can move into an empty
term. Reject schedules incompatible with price-version boundaries. Preserve actual
amounts and waivers on retained intervals. Align automatic schedules with changed
dates and stop them on archive.

Full deletion is a separate confirmed admin command. Preview original-currency
payments, periods, allocations, refunds and schedules. Delete dependencies atomically
and audit the action. Shared payments block the cascade. Editing a title/icon cannot
bypass lifecycle previews.

### Payments, credit and refunds

Choose the obligation first, then suggest its money and responsible person as payer.
The user confirms the actual date, amount and payer; select a payer explicitly if
none is suggested. Payments and periods have many-to-many allocations. Excess credit
is applied chronologically to later charges of the same obligation, never silently
to another obligation.

Active allocations in original money plus refunds cannot exceed the payment.
A refund is a separate positive returned amount, reducing available money and,
when necessary, allocations in the same atomic change. Never count it again as a
negative payment. Integer/decimal conversion and deterministic rounding must not
create money; refunds cannot exceed the original funds.

### Automatic payment records

An obligation may include an automatic schedule with payer, optional amount/currency
and effective dates. A separate payments view allows schedule creation and deletion;
deleting a schedule stops future entries but preserves payment history.

Creating an active schedule processes all already-due periods from its start through
today in the household timezone in the same server transaction. Create only the
missing amount for partial charges; covered periods receive a receipt without an
extra payment. Future periods are not prepaid. The same rule applies during
obligation creation and when adding a schedule later.

Background processing keeps a durable schedule/period receipt. Retries and a closed
browser must not duplicate payments. Production scheduling runs independently of
the browser. Entries are accounting assumptions, not confirmation of a bank statement.

### Currencies and historical valuation

Preserve original amounts/currencies while showing a base-currency valuation and
its rate date/source. Payments use the rate on `paidAt`, not entry time. ECB yearly
files in private S3 provide history; cross-rates use EUR. Non-publication days use
the last preceding quotation with its actual date, rejecting rates over ten days old.
Forecasts use the latest known quotation without promising future rates.

There is no manual-rate UI. Missing rates produce `EXCHANGE_RATE_REQUIRED`; an
unavailable source produces `EXCHANGE_SOURCE_UNAVAILABLE`. Never substitute 1:1.
Historical manual-rate tables/routes may remain for compatibility but are not used
by current production/local conversion adapters. Fresh ECB data does not silently
rewrite an existing payment's valuation.

Changing the base currency requires confirmation about rounding. Revalue payment
history on original payment dates and reconcile refunds/allocations while preserving
original money, without duplicate coverage or artificial credit.

For recent dates, check `rates/status.json` against a 15-minute freshness limit.
Request refresh through `rates-refresh/current.json`; missing historical years use
`rates-refresh/history.json`. A dedicated S3-triggered worker updates rates. Wait at
most 12 seconds, then return a retryable error. Recent updates merge a 90-day XML
feed; full history and daily EventBridge runs refresh the historical dataset.
The freshness limit describes source checks, not ECB publication frequency.

### Status and analytics

Settlement (`unpaid/partial/paid/waived/undetermined`), timing
(`upcoming/due/overdue`) and certainty (`confirmed/estimated/unknown`) are independent
derived states. Show partial overdue balances clearly. Unknown charges are not paid;
confirmed zero charges need no payment; waivers remain distinct. Known payments
remain visible even if the final charge is unknown.

Summaries distinguish accruals, expected payments and cash flow by `paidAt`.
Monthly stacked charts use a sole beneficiary's color and a stable shared-family
segment. Backdated payments must update historical debt calculations.

## 6. Persistence and concurrency

The financial register is one JSONB snapshot per family, with separate account,
membership, session, invitation, operation and audit tables. The snapshot is capped
at 4 MiB; normalization and range queries are future scaling work.

Commands carry `operationId`, `protocolVersion`, `instanceGeneration`,
`expectedRevision` and a batch. In one transaction:

1. Lock the account and family row, then recheck membership after waiting.
2. Check session validity and authorization for every command.
3. Return an existing receipt for the same actor/request hash; reject mismatched reuse.
4. Check generation and expected revision.
5. Validate references, money and rates and apply the complete batch.
6. Save the new snapshot, revision, audit and receipt, then commit.

Failure rolls back the whole batch. A lost response is resolved by querying the
operation or repeating the identical request and ID. A timeout does not prove
there was no commit. Concurrent commands on one revision yield one commit and one
conflict; preserve the second user's draft for review, without automatic money merging.

No long-lived tab lock is required. Transaction locks end at commit, rollback or
connection loss; timeouts bound abandoned work. Global session revocation changes
the generation and fresh-authentication threshold, while preserving the permitted
current admin session. Old authentication cannot reopen access. Revocation cannot
erase independently downloaded CSVs.

Scope caches and drafts to user/family. Switching accounts must not expose or send
another person's drafts. An offline shell grants no right to confirm server writes.

## 7. Interface

Support phones and laptops, Russian/English, keyboard interaction, visible focus
and actionable errors. Keep promotional filler out of working screens. An
obligation's category overrides its provider category. Appearance preferences
belong to the browser, not the financial register.

| Screen      | Requirements                                                                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in     | Google only; no demo or user-facing infrastructure credentials                                                                                     |
| No family   | Create a family or understand/accept an invitation                                                                                                 |
| Overview    | Four summary metrics, two monthly charts, grouped obligations and upcoming payments                                                                |
| Obligations | Optional responsible person, separate beneficiaries, end date, weekly recurrence, automatic schedule and icon                                      |
| Payments    | Obligation-first entry, original/base amounts, credit and a separate schedule list                                                                 |
| Family      | Name/color on the left, email/role on the right, admin first; one editor; pending email visually subdued; collapsible responsibility/benefit lists |
| Reports     | Date range and two CSV reports: obligations and payments                                                                                           |
| Settings    | Household name/shared color, currencies, locale/timezone, sessions and leaving; transfer head through a confirmed member's role                    |

Group one obligation's charges in the selected month into one row, with first/last
dates, total amount and aggregate status. Show paid/total for partial settlement,
otherwise the total alone. Any overdue balance makes the group overdue; remaining
debt otherwise means due; fully covered charges mean paid. Search, tabs and row
counts use groups, while financial totals sum individual periods. Grouping never
merges financial records or audit history.

Beneficiary labels use bold names and the person's chart color when singular;
groups and the whole family use the configurable shared color, default `#94A3B8`.
Keep the label on one line and offer a default-color reset.

The local icon picker has 50 general SVG icons and 36 provider icons across Music,
Film/TV and Services. Support tabs, search, keyboard, Escape, focus restoration and
a safe unknown-ID fallback. No remote logo requests. Preserve [attribution](icon-attribution.md).

Reports retain period selection, original currencies and base valuations. Two CSVs
satisfy the two-report requirement. Full backups and restore uploads are not user
exports. Historical import types do not imply a supported bank-import workflow.

### Service visibility on family cards

The benefit list shows currently active obligations and services with retained
positive payment, from the payment date until one calendar billing cycle later,
excluding the end. Prepayment is visible before the first charge; unallocated
advance credit uses the first applicable schedule. Full refunds/payment deletion
remove that extension. Partial refunds do not invent a proportional service term.

The responsibility list also shows assigned future active obligations before any
payment. An unpaid future responsibility does not imply current service use.
Use today in the household timezone. These are display rules, not changes to dates or balances.

## 8. API and modules

Routes below use the `/api` prefix in deployment.

| Area           | Routes                                                                   |
| -------------- | ------------------------------------------------------------------------ |
| Health/session | `GET /health`, `POST /auth/session`, `GET /session`, `POST /auth/logout` |
| Joining        | `POST /families`, `POST /invitations/accept`                             |
| Finance        | `GET /state`, `GET /sync/state`, `POST /commands`, `GET /operations/:id` |
| Members        | `GET /family/members`, `PATCH/DELETE /family/members/:subject`           |
| Invitations    | `POST /family/invitations`, `PATCH/DELETE /family/invitations/:id`       |
| Management     | `POST /family/transfer`, `POST /family/leave`                            |
| Sessions       | `GET /sessions`, `POST /sessions/:id/revoke`, `POST /admin/takeover`     |
| Operations     | `GET /admin/backups/status`                                              |

Use explicit errors such as `AUTH_REQUIRED`, `SESSION_REVOKED`, `FAMILY_REQUIRED`,
`ALREADY_IN_FAMILY`, `FORBIDDEN`, `REVISION_CONFLICT`, `GENERATION_MISMATCH`,
`IDEMPOTENCY_MISMATCH`, `EXCHANGE_RATE_REQUIRED` and `FAMILY_SIZE_LIMIT`. Preserve
correctable drafts and never display a rejection as a successful write.

CORS allows only the configured origin. OPTIONS requires no JWT and exposes no
financial data. Scheduled events are separate from user commands; the browser
cannot invoke `ExecuteAutomaticPayments` directly. The historical manual-rate
route is not part of the current user workflow.

See [architecture](architecture.md) for module responsibilities.

## 9. Backup, restoration and deletion

Run production maintenance hourly in bounded family batches; local maintenance
runs every minute while the API is active. Create a financial backup when its
revision changed, at most once per day. Retain seven daily and three monthly
representatives without duplicate objects.

Backups are private, encrypted at rest, integrity-checked and scoped by family.
Mark success only after verification; surface errors to the operator. Maintenance
retries must not duplicate financial entries.

Financial backups omit complete account, membership, invitation, historical manual
rate and receipt data. Disaster recovery requires a separate whole-application
database procedure with consistency and authorization checks. It must not roll
back other databases on the shared host; a whole-instance RDS snapshot is insufficient
evidence. Operator restoration requires a current-state backup, integrity/schema
validation, coordinated SQL switching and invalidation of stale sessions.

When the final account leaves, close access, revoke invitations and clear working
financial state immediately. Background batches remove its S3 prefix and remaining
SQL rows, resuming after failures. Do not delete other families, other applications,
RDS, Google/Cognito profiles or shared instance snapshots.

## 10. Security and operating limits

Validate input, enforce server permissions and bound payloads, batches and request
frequency. Prevent XSS and token leakage, keep buckets private and use minimum
IAM/SQL privileges. Never log full invitation links/outbox payloads. The trust
boundary includes AWS/database operators; the app cannot prevent their deliberate tampering.

Monitor API/worker errors, backup freshness/failures, outbox, rate freshness, SQL
connections, database load and cost. Limit Lambda load to protect shared RDS.
Disclose full-snapshot processing, 4 MiB state limits, external calls during SQL
transactions, local-email limitations and incomplete full-recovery rehearsal.

The 120,000-period domain fixture is a correctness/scaling reference, not verified
API capacity. Hosted scale claims require targeted SQL, memory/latency measurements
and end-to-end tests.

## 11. Acceptance scenarios

| ID    | Expected result                                                                            |
| ----- | ------------------------------------------------------------------------------------------ |
| AC-01 | Real Google login; reject forged/expired JWTs, wrong clients and unverified identities     |
| AC-02 | Family creation/invitation flow; exactly one head on creation                              |
| AC-03 | Concurrent membership attempts leave an account in at most one family                      |
| AC-04 | Foreign family/person/operation IDs reveal no data and grant no write access               |
| AC-05 | People without email work; invitations link without duplication                            |
| AC-06 | Seven-day invitation validity; reject wrong email, reuse, revocation and expiry            |
| AC-07 | Server-enforced roles; observers read amounts but cannot write                             |
| AC-08 | Atomic head transfer/exit; preserve history while the family remains                       |
| AC-09 | Last-account exit closes access; cleanup leaves other families/databases intact            |
| AC-10 | Responsibility and beneficiaries remain independent                                        |
| AC-11 | Weekly, month-end, leap-day and finite schedules avoid overlaps/duplicates                 |
| AC-12 | Ending an obligation stops charges but preserves debt                                      |
| AC-13 | Partial payment, future credit and refunds preserve money invariants                       |
| AC-14 | Two devices on one revision produce one commit and one conflict with a retained draft      |
| AC-15 | Lost-response retry is idempotent; changed content for the same ID fails                   |
| AC-16 | Failure between snapshot and receipt rolls back the whole batch                            |
| AC-17 | Closing a tab leaves no long-lived user lock                                               |
| AC-18 | Global revocation prevents old authentication reopening access                             |
| AC-19 | Repeated automatic runs do not duplicate entries; schedule deletion preserves history      |
| AC-20 | Preserve original money and rate on payment date; no missing-rate 1:1 fallback             |
| AC-21 | Base-currency change reconciles history without changing original money                    |
| AC-22 | Stable beneficiary/shared chart colors and correct backdated debt                          |
| AC-23 | Two accurate period-filtered CSVs; no full-backup export in the UI                         |
| AC-24 | Icon search, keyboard, focus and mobile layout work without remote logos                   |
| AC-25 | Verified backups and 7/3 retention; interrupted cleanup can resume                         |
| AC-26 | Selective database restore preserves other applications and verifies access/sessions       |
| AC-27 | Local PostgreSQL persists across restarts and rejects production DSNs                      |
| AC-28 | Development uses real Google JWT verification, without a fake administrator                |
| AC-29 | Unauthenticated OPTIONS works; financial routes require JWTs                               |
| AC-30 | Verify SES mode/sender, ECB initial load and cloud schedules                               |
| AC-31 | Creators cannot edit; own-editors cannot change others/unknown authors or forge authorship |
| AC-32 | Lifecycle policies cannot indirectly modify another author's related records               |
| AC-33 | Token refresh works; logout wins late refresh; revoked SQL sessions stay revoked           |
| AC-34 | Stale source checks trigger rate refresh; timeout never commits a fabricated rate          |
| AC-35 | Admin-only cascade deletion; shared payments block the entire operation                    |
| AC-36 | Unified person editor handles name/color/invitation/role and confirmed membership          |
| AC-37 | New active schedules immediately cover due charges without duplicates or future payments   |

Mark acceptance only from actual evidence. Unit tests do not replace real Google,
SES and RDS acceptance. Finish recovery and operational measurements before claiming
production readiness at a larger scale.
