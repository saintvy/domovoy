# Changelog

Notable product changes are recorded here in English. Dates identify development
milestones; they do not certify the state of any particular hosted installation.
The npm package version is an internal build identifier, not the product-specification version.

## Unreleased

### Deployment

- Support an optional canonical website domain with a validated ACM certificate,
  CloudFront HTTPS, Route 53 IPv4/IPv6 aliases and a redirect from the former hostname.
- Keep Cognito callbacks, API CORS, invitation links and runtime configuration
  consistent with the canonical origin.

### Repository

- Adopt Domovoy as the official project and package name.
- Publish English product, architecture, development and deployment documentation.
- Consolidate historical release notes and remove obsolete operator diaries,
  workstation instructions, unused authentication utilities and manual-rate UI.
- Add CI for formatting, builds, domain tests, real PostgreSQL, Chromium, PWA and
  credential-free infrastructure synthesis.
- Add contribution and security guidance, issue templates and dependency updates.
- Preserve deployed database, storage and API identifiers for compatibility.
- Use the Domovoy name for downloaded CSV reports.
- Keep the scale-test reporter responsive between CPU-intensive stages without
  relaxing financial assertions or timing guards.

## 2026-09-21

### Website

- Publish the application at [domovoy.click](https://domovoy.click/) with HTTPS,
  DNS aliases and matching OAuth/API configuration. The former CloudFront
  hostname redirects to the new address.

### Added

- Backfill already-due, unpaid charges when an active automatic payment schedule
  is created. Partial charges receive only the missing amount; future charges and
  completed runs do not create duplicate payments.
- Configure a shared household color, used consistently by the chart and
  beneficiary labels. Existing households retain the default `#94A3B8`.

### Changed

- Group multiple charges for one obligation into a single monthly row with a date
  range, aggregate status and paid/total amount. Underlying charges and payments
  remain separate. Opening the row selects the first charge needing attention,
  or the last charge when all are paid.
- Show beneficiary names in bold using the person's color or shared family color.

## 2026-09-20

### Fixed

- Show prepaid services on family cards before their first charge, using the
  payment date and calendar billing cycle.
- Show responsibility for future obligations before the first payment without
  implying that the service is currently in use.

## 2026-09-19 — Product specification 3.2

### Added

- Light, dark and system appearance modes, stored as a browser preference.
- Obligation-specific categories, summary navigation and compact family cards.

### Fixed

- Person color editing and stable ordering of chart segments.
- Service visibility based on payment history and calendar cycles.

## 2026-09-18 — Product specification 3.1

### Added

- Server-assigned record authorship with create-only, own-record and all-record permissions.
- A unified person editor for name, color, invitation email and access.
- Previewed date changes, archiving and administrator-only cascade deletion.
- Cognito token refresh and sliding family sessions with revocation checks.
- A dedicated ECB worker with on-demand refresh through S3 events.

### Fixed

- Prevent lifecycle edits from changing another author's related payments or schedules.
- Protect shared payments and refund chronology during date changes and deletion.

## 2026-09-16–17 — Product specification 3.0

### Added

- Google-only authentication, isolated families, invitations and household roles.
- Recurring billing, multicurrency payments, automatic accounting records and server backups.
- Local PostgreSQL development with real Cognito authentication.
- Effective-dated price changes and a price-history chart.

### Fixed

- Restore nested Google identity claims from the same JWT verified by API Gateway.
