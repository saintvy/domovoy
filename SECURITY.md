# Security policy

Security fixes target the current default branch. There is no maintained support
matrix for older snapshots.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/saintvy/domovoy/security/advisories/new)
when it is enabled. If the private form is unavailable, open an issue containing
only a request for a private reporting channel, without vulnerability details.
Do not post credentials, invitation links, household data or an exploitable proof
of concept in a public issue.

Include the affected commit, prerequisites, impact and a minimal reproduction
using fictional data. A response-time guarantee is not currently offered.

## Security boundaries

Google/Cognito authenticates accounts. The API verifies family membership,
session validity and command permissions; hiding a UI control is not authorization.
JWTs and refresh tokens are accessible to JavaScript in the current tab, so XSS
prevention remains essential. The browser cache is not an authorization boundary.

Deployment secrets belong in ignored local parameter files and protected AWS
configuration. The repository contains examples only. Financial S3 backups do
not replace a tested recovery procedure for the entire application database.

See [architecture](docs/architecture.md), [deployment](docs/deployment.md) and
[current limitations](docs/implementation-status.md) for the operational model.
