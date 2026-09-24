import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fromIni } from '@aws-sdk/credential-providers';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { readConfig } from '../infra/config';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const tokenName = '/domovoy/telegram/bot-token';
const webhookName = '/domovoy/telegram/webhook-secret';

async function main() {
  const action = option('--action') ?? 'status';
  if (!['provision', 'register', 'status'].includes(action))
    throw new Error('Use --action provision|register|status');
  const profile = option('--profile');
  if (!profile) throw new Error('An explicit --profile is required');
  const config = readConfig(option('--config') ?? 'infra/config.local.json');
  const credentials = fromIni({ profile });
  const options = { region: config.region, credentials };
  const identity = await new STSClient(options).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account !== config.brownieAccountId)
    throw new Error('Wrong AWS account');
  const ssm = new SSMClient(options);
  async function parameter(name: string) {
    try {
      return (
        await ssm.send(
          new GetParameterCommand({ Name: name, WithDecryption: true }),
        )
      ).Parameter?.Value;
    } catch (error) {
      if ((error as { name?: string }).name === 'ParameterNotFound')
        return undefined;
      throw new Error('Cannot read Telegram SSM parameter');
    }
  }
  async function telegram(token: string, method: string, body: unknown = {}) {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        },
      );
      const value = (await response.json()) as { ok?: boolean; result?: any };
      if (!response.ok || !value.ok) throw new Error();
      return value.result;
    } catch {
      throw new Error(
        `Telegram ${method} failed; sensitive provider details omitted`,
      );
    }
  }
  if (action === 'provision') {
    const env = parseEnv(readFileSync(option('--env') ?? '.env.local', 'utf8'));
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token || !/^\d{5,}:[A-Za-z0-9_-]{25,}$/.test(token))
      throw new Error(
        'TELEGRAM_BOT_TOKEN is missing or invalid in the ignored environment file',
      );
    const bot = await telegram(token, 'getMe');
    if (bot?.username !== 'domovoy_reminder_bot' || !bot.is_bot)
      throw new Error('Token does not belong to domovoy_reminder_bot');
    const existing = await parameter(tokenName);
    if (existing && existing !== token && !args.includes('--replace-token'))
      throw new Error(
        'Existing token differs; use --replace-token for an intentional rotation',
      );
    if (existing !== token)
      await ssm.send(
        new PutParameterCommand({
          Name: tokenName,
          Value: token,
          Type: 'SecureString',
          Tier: 'Standard',
          Overwrite: Boolean(existing),
        }),
      );
    if (!(await parameter(webhookName)))
      await ssm.send(
        new PutParameterCommand({
          Name: webhookName,
          Value: randomBytes(32).toString('hex'),
          Type: 'SecureString',
          Tier: 'Standard',
        }),
      );
    console.log(
      'Verified @domovoy_reminder_bot; Telegram SecureString parameters are ready. Values were not printed.',
    );
    return;
  }
  const token = await parameter(tokenName);
  if (!token) throw new Error('Provision the Telegram parameters first');
  const cloud = new CloudFormationClient(options);
  const stack = (
    await cloud.send(new DescribeStacksCommand({ StackName: 'BrownieApp' }))
  ).Stacks?.[0];
  const expected = stack?.Outputs?.find(
    (output) => output.OutputKey === 'TelegramWebhookUrl',
  )?.OutputValue;
  if (action === 'register') {
    if (
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(
        stack?.StackStatus ?? '',
      ) ||
      !expected
    )
      throw new Error(
        'Deploy and verify the Telegram stack before registering the webhook',
      );
    const secret = await parameter(webhookName);
    if (!secret) throw new Error('Provision the webhook secret first');
    await telegram(token, 'setWebhook', {
      url: expected,
      secret_token: secret,
      allowed_updates: ['message'],
      max_connections: 2,
      drop_pending_updates: false,
    });
  }
  const status = await telegram(token, 'getWebhookInfo');
  console.log(
    JSON.stringify({
      registered: Boolean(status.url),
      matchesDeployment: Boolean(expected && status.url === expected),
      pendingUpdateCount: status.pending_update_count,
      hasDeliveryError: Boolean(status.last_error_date),
    }),
  );
}
main().catch((error) => {
  // AWS exceptions can embed request details; only our static errors are printable.
  const safe = error instanceof Error && error.constructor === Error;
  console.error(
    safe ? error.message : 'Telegram setup failed; provider details omitted',
  );
  process.exitCode = 1;
});
