# Verification

Run checks from the repository root after `npm ci`. No AWS credentials are needed
for formatting, build, unit, browser or infrastructure synthesis checks.

| Command                | Evidence                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `npm run format:check` | Formatting of maintained source, configuration and documentation                        |
| `npm run build`        | Application type checking and a production Vite build                                   |
| `npm run test:quick`   | Financial rules, family API, permissions, identity, backup encryption and configuration |
| `npm run test:scale`   | Domain invariants and restoration for 500 obligations across 20 years                   |
| `npm run test:e2e`     | Chromium workflows, authorization failures, drafts, lifecycle edits and reporting       |
| `npm run test:pwa`     | Built shell caching, offline loading and exclusion of private responses                 |
| `npm run deploy:check` | Infrastructure types and assertions over four synthesized CloudFormation stacks         |

Install the browser with `npx playwright install chromium` (on Linux CI, use
`--with-deps`). Browser tests use a dedicated Vite server on port 5173; PWA tests
use the production preview on port 4173. Keep those ports free for reproducible runs.

The real PostgreSQL integration case is enabled with `BROWNIE_TEST_DOCKER=1`
after `node scripts/dev-db.mjs up`. See the shell-specific commands in
[local development](local-development.md#real-postgresql-test). Without that flag
the case is intentionally skipped. CI runs it in a separate job with its own database.

The same flag enables `tests/telegram-postgres.test.ts`, which exercises concurrent
link consumption and competing one-time report claims through the actual worker
and bridge against PostgreSQL. Run both SQL test files with `--maxWorkers=1` to
serialize schema setup; the concurrency test itself opens competing transactions.

## Test boundaries

Member lifecycle regressions live in `tests/member-lifecycle.test.ts`,
`tests/member-lifecycle-api.test.ts` and `e2e/member-lifecycle.spec.ts`.
They cover virtual Nobody references, historical attribution, restoration provenance,
charge cutoffs, protected future records, admin authorization, access revocation,
invitation races, receipt retries, rollback and the family/archive UI. API fixtures
use PGlite; they do not replace PostgreSQL concurrency validation or live sign-in.
`tests/member-lifecycle-postgres.test.ts`, enabled with `BROWNIE_TEST_DOCKER=1`,
also exercises real account/family lock ordering, concurrent target requests and
invitation acceptance during archival, plus receipt replay. Run PostgreSQL files
with `--maxWorkers=1` to serialize schema initialization. This test creates and
cleans only its own random synthetic family and account records.

Browser fixtures intercept API calls and use fictional household data. They test
UI behavior, not real Google consent, SES delivery or production RDS connectivity.
Local JWT tests exercise signature verification using test-only keys; the normal
development server has no fake-identity mode.

Infrastructure synthesis verifies generated resources, not the permissions or
state of a deployed account. The domain scale test is not an API throughput or
capacity test. A successful build is not a disaster-recovery rehearsal.

Telegram reminder verification additionally covers domain selection and original
money, backend schedule/link/receipt transactions, webhook authentication and
provider ambiguity, and the reminder settings browser workflow. Deployment checks
assert the private bridge/public worker boundary, scoped parameter access, hourly
UTC cron and disabled initial rollout. Live Telegram delivery requires an actual
member to complete the one-use link; mock provider tests and SSM provisioning
do not prove delivery to a real chat.

Invitation regression checks cover a fragment arriving after application startup,
the Google logout/PKCE/callback sequence, and acceptance into the existing household
with the invited role. Language tests cover saved/browser/country precedence,
geography failure and late-response races, authenticated account preferences,
recipient language at Telegram claim, and escaped bilingual email templates.
The browser OAuth test uses intercepted identity-provider responses; it does not
claim a live Google sign-in. Layout checks remain shallow, including desktop/mobile
family cards and independent settings columns.

For a hosted release, additionally complete the checks in
[deployment](deployment.md#cloud-acceptance-and-operations). Record the commit,
environment, commands, outcomes and any skipped acceptance cases in the release
or pull request. Do not include personal data or secret configuration in evidence.

## Documentation screenshot

The README uses fictional data from the existing appearance regression scenario.
To regenerate it, run:

```sh
npx playwright test e2e/interface-refinements.spec.ts --grep "dark green theme"
```

Inspect the resulting `overview-english.png` in `test-results`, then copy it to
`docs/images/overview.png`. Do not capture a real household for public documentation.

## Continuous integration

[CI](../.github/workflows/ci.yml) runs on pushes and pull requests, with separate
jobs for source/infrastructure checks, Chromium/PWA and real PostgreSQL. Actions
are pinned to commit hashes, the workflow token is read-only, and deployment is
not part of CI. Failed browser runs retain diagnostic artifacts for seven days.
