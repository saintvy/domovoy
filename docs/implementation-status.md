# Capabilities and limitations

This document describes the source tree, not the current state of a specific
AWS account. Public documentation deliberately excludes deployment identifiers,
personal accounts, support cases and operator activity logs.

## Implemented

| Area              | Behavior                                                                           |
| ----------------- | ---------------------------------------------------------------------------------- |
| Identity          | Google/Cognito, PKCE, state/nonce, verified JWT claims and refresh                 |
| Families          | One account in at most one family; one family head; people without logins          |
| Permissions       | Observer, creator, own-record editor, all-record editor and administrator          |
| Authorship        | Server-assigned immutable authors for obligations, payments and schedules          |
| Invitations       | Email-bound, hashed, single-use tokens with seven-day expiry                       |
| Consistency       | SQL row locks, revision/generation checks and atomic idempotency receipts          |
| Obligations       | Recurrence, categories, icons, beneficiaries, lifecycle previews and price history |
| Payments          | Original and base-currency amounts, partial payments, credit and refunds           |
| Automatic records | Immediate backfill of due charges and idempotent background processing             |
| Rates             | ECB history, date-aware conversion and a dedicated refresh worker                  |
| Reporting         | Two period-filtered CSV reports; server-managed financial backups                  |
| UI                | Russian/English, light/dark/system themes, responsive views and monthly grouping   |
| Development       | Docker PostgreSQL and genuine Cognito verification; PGlite only in tests           |

## Known limitations

- Financial snapshots are capped at 4 MiB and loaded/validated in full. Requests
  within a family serialize; some service calls keep the transaction open.
- The scale suite exercises 120,000 billing periods in the domain layer. It does
  not establish that the hosted API can accept a dataset of that size.
- Refresh tokens are JavaScript-accessible in tab `sessionStorage`; XSS protection
  is essential. Token refresh cannot restore revoked family access.
- ECB freshness means the age of the source check, not a promise of newly
  published quotations. Missing currencies/dates fail explicitly. There is no
  user-facing manual-rate override.
- Local email delivery is not implemented. Hosted invitation delivery depends
  on SES identity verification and the account's sandbox/production status.
- An invitation API response confirms outbox persistence, not email delivery.
- Financial backups omit the complete SQL account/access/receipt state. Selective
  full-database disaster recovery still needs a documented rehearsal.
- Leaving as the last account closes a family immediately. There is no seven-day
  deletion undo period; seven days is the invitation validity period.
- The PWA shell can load offline, but offline mode cannot authorize server writes.

## Next engineering work

1. Rehearse isolated full-database recovery and verify post-restore access/session behavior.
2. Complete cloud acceptance with real Google identities, SES delivery and scheduled jobs.
3. Measure hosted latency, memory, connections and cost with representative households.
4. Move toward targeted SQL operations and shorter transactions if measurements justify it.
5. Add a supported local email adapter.

See [verification](verification.md) for reproducible checks and their boundaries.
