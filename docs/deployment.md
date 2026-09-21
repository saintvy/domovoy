# AWS deployment

The maintained installation is available at [domovoy.click](https://domovoy.click/).
Its former CloudFront hostname redirects to this canonical HTTPS address.

Domovoy deploys a static frontend and a serverless API. The supplied CDK templates
expect an existing PostgreSQL 16 RDS instance in a separate AWS account and the
same region. They do not provision the database host. Read the
[architecture](architecture.md) before choosing this topology.

## Configuration and accounts

Copy `infra/config.example.json` to ignored `infra/config.local.json`. Replace the
example account IDs, VPC, route tables, security group, RDS endpoint, availability
zones, Google OAuth client ID and Cognito domain prefix with your environment's
values. Configure a verified SES sender if invitations are required.

Historical `brownie*` fields identify the application account; `wcc*` fields
identify the account hosting the existing RDS instance. Keep stack IDs and
database identifiers stable for an existing installation. Database validation
requires a dedicated `brownie` or `brownie_<environment>` database and a
`brownie_*` runtime login.

Use explicit AWS profiles, preferably backed by SSO, and verify the account with
`aws sts get-caller-identity --profile PROFILE`. The deploy script checks the
account again. Bootstrap the CDK environment in each target account as required
by your organization's AWS policy.

Copy the relevant `infra/parameters.<target>.example.json` files to
`infra/parameters.<target>.local.json`. Fill them privately. Database passwords
and the Google client secret are passed through the SDK to CloudFormation
`NoEcho` parameters; never put them in source, shell arguments or runtime JSON.
`NoEcho` is not a substitute for restricted IAM and protected local files.

## Stacks

| Target     | Stack ID               | Account       | Responsibility                                                           |
| ---------- | ---------------------- | ------------- | ------------------------------------------------------------------------ |
| `network`  | `BrownieNetwork`       | Application   | Isolated subnets, API security group, S3 endpoint, peering accepter role |
| `bridge`   | `WccBrownieBridge`     | Database host | Peering, return routes and scoped PostgreSQL ingress                     |
| `app`      | `BrownieApp`           | Application   | Frontend, API, Cognito, workers, storage and schedules                   |
| `database` | `BrownieDatabaseSetup` | Application   | Temporary IAM-only database provisioner reaching RDS through peering     |

The provisioner receives database administrator credentials only for setup. The
runtime Lambda receives a separate restricted SQL login. Remove the temporary
provisioner after migration and verification.

## Validate without AWS access

```sh
npm ci
npm run deploy:check
```

This builds the frontend, type-checks infrastructure and synthesizes all four
stacks with placeholder configuration. Assertions check resource boundaries,
secret parameter flags, JWT/preflight setup and runtime-config publication order.
It performs no deployment and needs no AWS credentials.

Individual targets also support `--synth-only`:

```sh
npm run deploy -- --target network --config infra/config.example.json --synth-only
```

## First installation

1. Review non-overlapping VPC CIDRs, route tables and RDS security groups. Keep
   RDS private and require verified TLS for SQL connections.
2. Deploy `network` in the application account. Use its VPC, security group and
   accepter-role outputs to populate the bridge parameters.
3. Deploy `bridge` in the database-host account. Put the returned peering ID in
   the application parameters.
4. Deploy `app` to create application-side routes and resources. The API is not
   ready for financial use until the dedicated database has been provisioned.
5. Deploy `database` in the application account. Invoke its setup Lambda through
   IAM with an event containing `{"action":"provision"}`. The provisioner creates
   the dedicated database and roles, applies the schema and idempotent migrations,
   and grants restricted runtime access. Inspect the result before continuing.
6. Verify runtime TLS, application SQL privileges and isolation from other
   databases. Delete the temporary `BrownieDatabaseSetup` stack after success.
7. Complete Google/Cognito and SES setup below. Load ECB history with the rates
   worker and verify scheduled maintenance.
8. Perform the cloud acceptance checks before inviting households.

Prepare an application change set, replacing `APPLICATION_PROFILE` with your profile:

```sh
npm run deploy -- --target app --config infra/config.local.json --profile APPLICATION_PROFILE --parameters infra/parameters.app.local.json
```

By default this uploads assets and creates a change set, but does not execute it.
Review its exact resource changes in CloudFormation, then execute that change set
in the AWS console. `--execute` instead creates and immediately starts a new change
set. The command does not wait for deployment completion; check stack events and
`CREATE_COMPLETE` or `UPDATE_COMPLETE` before the next stage.

## Google and runtime configuration

Configure Google as the only Cognito identity provider. The Google web client's
authorized redirect is the Cognito `/oauth2/idpresponse` URL. Use distinct public
Cognito app clients for the hosted origin and localhost, with authorization code
flow, PKCE, `openid email profile`, and exact callback/logout URLs.

The deployment publishes public `runtime-config.json` after the frontend assets.
It contains API and Cognito identifiers, never a client secret. Test a complete
real Google login and callback: reaching the consent screen alone is insufficient.

### Custom website domain

An optional `customDomain` object in the private deployment configuration makes
an owned domain the canonical frontend origin:

```json
{
  "customDomain": {
    "domainName": "app.example.com",
    "hostedZoneId": "Z0123456789",
    "certificateArn": "arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000"
  }
}
```

Use a public hosted zone for that domain in the application account. Request an
ACM certificate for the exact hostname in **us-east-1**, create its DNS validation
CNAME in Route 53, and wait for `ISSUED` before executing the application change
set. Keep the validation record for managed certificate renewal. The certificate
is managed separately and imported by ARN, because CloudFront requires its
certificate in us-east-1 while the application stack runs in another region.

The application stack adds the CloudFront alias and Route 53 A/AAAA alias records,
uses TLS 1.2 or later, and updates the Cognito production callback/logout URLs,
API CORS, server origin and public runtime configuration together. A viewer-request
function redirects the former CloudFront hostname to the canonical HTTPS hostname,
preserving paths and query values. Localhost authentication remains separate.
The Google provider's `/oauth2/idpresponse` callback stays on the same Cognito domain.

After deployment, verify DNS, HTTPS, the former-host redirect, the new runtime
callback, API preflight and the authorization redirect to Google. An existing
browser session belongs to its previous origin; sign in again on the new domain.

## Invitation email

Verify the configured SES sender identity in the deployment region. SES sandbox
environments also require verified recipients; a verified sender alone does not
permit delivery to arbitrary addresses. Request production access when needed
and inspect its actual approval state in your AWS account.

The API queues an invitation in a private S3 outbox. A worker sends it through
SES. A successful API response confirms queuing, not receipt. Worker retries may
repeat an email with the same one-time token. Monitor delivery failures and outbox age.

## Updating an installation

Run the checks, inspect the changelog and determine whether schema migrations are
required. Apply migrations with the provisioner, then publish the verified app
change set. Preserve the previous artifact/configuration for rollback; restoring
old JavaScript cannot reverse a database migration.

## Cloud acceptance and operations

- Verify HTTPS, health, unauthenticated OPTIONS, and rejection of missing/forged JWTs.
- Complete real Google login, token refresh, invitation acceptance and session revocation.
- Use two accounts/devices to verify role boundaries, isolation, conflicts and safe retries.
- Check ECB initial load, refresh triggers, due automatic payments and hourly maintenance.
- Verify backups, their integrity and retention, and resume cleanup after an interrupted run.
- Monitor API/worker errors, outbox age, rate freshness, SQL connections, RDS load and AWS cost.

Financial object backups do not contain every account, invitation or operation
receipt. Rehearse selective recovery of the application database without rolling
back other databases on the shared RDS instance. A whole-instance snapshot alone
does not prove that recovery procedure. See [current limitations](implementation-status.md).
