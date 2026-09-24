# Telegram daily reminders

## Implementation brief

Provide a daily personal report through `@domovoy_reminder_bot`, addressed only
to the account linked to an obligation's responsible person. Beneficiaries do not
determine recipients. Skip unlinked accounts and empty reports.

Acceptance criteria:

- Family settings provide a default report time; family/access settings allow a
  member override. The chosen local hour and IANA timezone are retained across
  daylight-saving changes; the next trigger is stored as a UTC instant. An
  hourly EventBridge rule drives server-side evaluation.
- Creation and editing support enabled/disabled reminders, lead days, and either
  one reminder per billing period or daily reminders until settlement.
- Existing non-automatic obligations default to daily reminders starting one day
  before payment is due; automatic obligations default to disabled reminders.
- Reports group original-currency outstanding amounts and due dates under
  `⚠️ Просрочено`, `📅 К оплате`, and `🔄 Автоплатеж`. Estimates remain labelled;
  automatic accounting entries never imply bank confirmation.
- Signed-in members can link, relink and unlink their own private Telegram chat
  through expiring one-use links. Cross-family access and token replay fail.
- Duplicate scheduler events and worker invocations cannot create duplicate
  logical reports. Delivery state distinguishes a provider acceptance from an
  ambiguous timeout. Queued jobs are rechecked against current membership,
  linking and financial state before an attempt.
- PostgreSQL remains authoritative. Database compute stays private; external
  workers have no SQL credentials. No NAT gateway, paid interface endpoint,
  always-on service or Secrets Manager is introduced.
- The bot token stays outside Git and browser assets, using SSM Parameter Store
  `SecureString` in production and an ignored local environment file.

Payment commands inside Telegram, bank integration, and unrelated financial or
authorization redesign are outside this change.

Affected layers are domain reminder selection, authenticated family APIs and SQL
delivery records, the client forms, external Telegram delivery, and AWS CDK.
Verification includes domain money/date cases, SQL authorization/replay/retry
cases, worker failure cases, browser workflows, and infrastructure synthesis.

## Architecture and delivery

An hourly UTC cron invokes a private Telegram bridge. PostgreSQL records member
schedules and durable report jobs. After commit, a private S3 object containing
only `{version: 1, jobId}` wakes the internet-capable Telegram worker. The worker
has permission to invoke only the Telegram bridge, delete its own wakeups, and
read the two named SSM parameters. It has no SQL configuration or financial API
authority.

Before returning message text, the bridge checks the current family, membership,
binding, responsibility and remaining payment balance and records an attempt.
The worker then calls `sendMessage` and acknowledges the result. Telegram does
not provide a client idempotency key: a timeout after acceptance cannot be
distinguished from non-delivery. Such an attempt is recorded as unknown and is
not automatically resent. A crash after claim but before the HTTP request can
therefore omit a report. Explicit provider throttling is retryable. A payment or
unlink after the final send authorization can race with an already in-flight
request; queued jobs are revalidated.

The report timezone controls delivery; the household timezone controls accounting
dates and overdue status. A repeated DST hour is used once, and a missing hour is
shifted to the next available hourly boundary. For zones with fractional UTC
offsets, a minute-zero UTC event may occur at local `:30` or `:45`; settings explain
this limitation. The family default is 09:00 in its timezone until configured.

## Deployment and secrets

Keep `TELEGRAM_BOT_TOKEN` in ignored `.env.local` for operator setup. Never prefix
it with `VITE_`, copy it into public runtime configuration, or pass it as a shell
argument. Production values are Standard-tier SecureStrings:

- `/domovoy/telegram/bot-token`
- `/domovoy/telegram/webhook-secret`

The setup script verifies the configured AWS account and bot identity and does
not print token values. It preserves an existing webhook secret. Token rotation
requires an intentional `--replace-token`; worker caches expire after five minutes.

```sh
npx tsx scripts/setup-telegram.ts --action provision --profile vitalii-brownie
```

Before deploying the application, apply the additive schema through the existing
owner-level database provisioner and grant runtime access to the new tables.
The ordinary runtime login intentionally has no DDL privileges. The migration
must preserve existing financial state and explicit reminder settings.

Deploy with `telegramRemindersEnabled: false` first. Verify SQL connectivity and
bridge/worker permissions, then register the webhook from stack outputs:

```sh
npx tsx scripts/setup-telegram.ts --action register --profile vitalii-brownie
npx tsx scripts/setup-telegram.ts --action status --profile vitalii-brownie
```

Enable `telegramRemindersEnabled` in the ignored deployment configuration and
deploy the reviewed change. A member must open their generated link and press
Start in Telegram before any report can be delivered. Setup verification alone
does not prove real report delivery.

## Operations and cost

Inspect durable report states and scheduler/worker error counts without logging
message text, chat IDs, tokens or links. Investigate queued-job age, provider
throttling, failed/unknown attempts, and webhook pending updates. Keep logs bounded
to two weeks and S3 wakeups to two days; SQL remains the delivery authority.
One invocation drains up to ten batches of 100 members; remaining due timestamps
stay durable for subsequent processing. This is a bounded household deployment,
not a verified high-volume notification service. Scale testing of the financial
domain does not establish hosted notification throughput.
SQL job, update and link-token history currently remains for the lifetime of the
associated data (update receipts are global). Monitor its growth; automated SQL
retention is a follow-up for larger installations. One-time delivery receipts
must survive any cleanup that could otherwise repeat a reminder.

This adds two usage-billed Lambdas, hourly EventBridge invocations, API Gateway
webhook calls, S3 requests, SSM reads/decryption, and logs. It reuses the existing
database, VPC and S3 gateway endpoint; it adds no NAT, paid interface endpoint,
database instance or always-on service. Actual monthly cost depends on member
count, report size, retries and regional pricing; no zero-cost guarantee is made.

For a 31-day month, the schedule produces 744 invocations. Four linked members
receiving one single-part report daily add at most 124 worker invocations and
248 claim/acknowledgement invocations before retries: 1,116 total. At an illustrative
two seconds per scheduler/worker invocation and 100 ms per claim/acknowledgement,
the configured memory gives about 818 GB-seconds. Multiply measured durations
and request counts by the current [Lambda rates](https://aws.amazon.com/lambda/pricing/),
then add S3, API Gateway, logs and applicable [Parameter Store/KMS charges](https://aws.amazon.com/systems-manager/pricing/).
These are sizing assumptions, not measured production latency or a billing quote.

## Provider references

The implementation follows Telegram's [private-chat deep links](https://core.telegram.org/bots/features#deep-linking)
and [Bot API](https://core.telegram.org/bots/api), AWS [UTC scheduled rules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html),
and [SSM Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html).
