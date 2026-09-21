import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  CreateChangeSetCommand,
  DescribeChangeSetCommand,
  ExecuteChangeSetCommand,
  waitUntilChangeSetCreateComplete,
  type Parameter,
} from '@aws-sdk/client-cloudformation';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-providers';
import { readConfig } from './config';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name: string) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
function run(
  script: string,
  commandArgs: string[],
  capture = false,
  environment: NodeJS.ProcessEnv = {},
): string {
  const child = spawnSync(
    process.execPath,
    [resolve(root, script), ...commandArgs],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: capture ? 'pipe' : 'inherit',
      windowsHide: true,
      env: { ...process.env, ...environment },
    },
  );
  if (child.status !== 0)
    throw new Error(`Command failed: ${script} (exit ${child.status})`);
  return child.stdout ?? '';
}

async function main() {
  const target = option('--target') ?? '';
  const names: Record<string, string> = {
    network: 'BrownieNetwork',
    bridge: 'WccBrownieBridge',
    app: 'BrownieApp',
    database: 'BrownieDatabaseSetup',
  };
  if (!names[target])
    throw new Error(
      'Use --target network|bridge|app|database --config infra/config.local.json --profile <AWS-profile> [--parameters <ignored-local.json>] [--execute] [--synth-only]',
    );
  const configPath = resolve(
    root,
    option('--config') ?? 'infra/config.local.json',
  );
  const config = readConfig(configPath);
  const stackName = names[target];
  const account =
    target === 'bridge' ? config.wccAccountId : config.brownieAccountId;
  const out = resolve(root, 'infra/cdk.out', target);
  run('node_modules/aws-cdk/bin/cdk', [
    '--app',
    `node --import tsx "${resolve(root, 'infra/app.ts')}"`,
    '--output',
    out,
    'synth',
    stackName,
    '-c',
    `config=${configPath}`,
    '-c',
    `target=${target}`,
    '--quiet',
  ]);
  if (args.includes('--synth-only')) {
    console.log(`Synthesized ${stackName}; no AWS calls or deployment.`);
    return;
  }
  const profile = option('--profile');
  if (!profile)
    throw new Error('An explicit --profile is required for account safety');
  const credentials = fromIni({ profile });
  const client = new CloudFormationClient({
    region: config.region,
    credentials,
  });
  // The local profile is never silently substituted with the other project's account.
  const { STSClient, GetCallerIdentityCommand } =
    await import('@aws-sdk/client-sts');
  const identity = await new STSClient({
    region: config.region,
    credentials,
  }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== account)
    throw new Error(`Wrong AWS account for ${target}; expected ${account}`);
  const parameterPath = option('--parameters');
  const values = parameterPath
    ? (JSON.parse(readFileSync(resolve(root, parameterPath), 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  if (
    !values ||
    Array.isArray(values) ||
    Object.values(values).some((v) => typeof v !== 'string')
  )
    throw new Error(
      'Parameter file must be an object of parameter names and string values',
    );
  const manifest = JSON.parse(
    readFileSync(resolve(out, 'manifest.json'), 'utf8'),
  );
  const artifact = manifest.artifacts[stackName];
  const templateFile = resolve(out, artifact.properties.templateFile);
  const templateBody = readFileSync(templateFile, 'utf8');
  const template = JSON.parse(templateBody);
  let exists = false;
  try {
    const current = await client.send(
      new DescribeStacksCommand({ StackName: stackName }),
    );
    // An unexecuted CREATE change set leaves a placeholder stack, not an updatable deployment.
    exists = current.Stacks?.[0]?.StackStatus !== 'REVIEW_IN_PROGRESS';
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('does not exist'))
      throw error;
  }
  for (const key of Object.keys(values))
    if (!template.Parameters?.[key])
      throw new Error(`Unknown CloudFormation parameter: ${key}`);
  const parameters = Object.entries(
    template.Parameters ?? {},
  ).flatMap<Parameter>(([key, spec]: [string, any]) => {
    if (typeof values[key] === 'string')
      return [{ ParameterKey: key, ParameterValue: values[key] as string }];
    if ('Default' in spec) return [];
    if (exists) return [{ ParameterKey: key, UsePreviousValue: true }];
    throw new Error(`Parameter ${key} is required in the local parameter file`);
  });
  for (const dependency of artifact.dependencies ?? []) {
    const asset = manifest.artifacts[dependency];
    // cdk-assets also creates STS clients before selecting an asset destination.
    // Supply the configured region explicitly; --profile alone can leave STS regionless.
    if (asset?.type === 'cdk:asset-manifest')
      run(
        'node_modules/cdk-assets/bin/cdk-assets',
        [
          'publish',
          '--path',
          resolve(out, asset.properties.file),
          '--profile',
          profile,
        ],
        false,
        {
          AWS_REGION: config.region,
          AWS_DEFAULT_REGION: config.region,
          AWS_PROFILE: profile,
        },
      );
  }
  const bucket = `cdk-hnb659fds-assets-${account}-${config.region}`;
  const key = `brownie-templates/${stackName}/${createHash('sha256').update(templateBody).digest('hex')}.json`;
  await new S3Client({ region: config.region, credentials }).send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: templateBody,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    }),
  );
  const name = `brownie-${Date.now()}`;
  const result = await client.send(
    new CreateChangeSetCommand({
      StackName: stackName,
      ChangeSetName: name,
      ChangeSetType: exists ? 'UPDATE' : 'CREATE',
      TemplateURL: `https://${bucket}.s3.${config.region}.amazonaws.com/${key}`,
      Parameters: parameters,
      Capabilities: [
        'CAPABILITY_IAM',
        'CAPABILITY_NAMED_IAM',
        'CAPABILITY_AUTO_EXPAND',
      ],
      RoleARN: artifact.properties.cloudFormationExecutionRoleArn?.replaceAll(
        '${AWS::Partition}',
        'aws',
      ),
      Description:
        'Brownie deployment; secrets are supplied directly to CloudFormation NoEcho parameters',
    }),
  );
  try {
    await waitUntilChangeSetCreateComplete(
      { client, maxWaitTime: 180, minDelay: 5, maxDelay: 10 },
      { StackName: stackName, ChangeSetName: result.Id },
    );
  } catch {
    const failed = await client.send(
      new DescribeChangeSetCommand({
        StackName: stackName,
        ChangeSetName: result.Id,
      }),
    );
    if (
      failed.StatusReason?.includes("didn't contain changes") ||
      failed.StatusReason?.includes('No updates are to be performed')
    ) {
      console.log('No infrastructure changes.');
      return;
    }
    throw new Error(
      'CloudFormation rejected the change set. Inspect its Events/Status in the AWS console; parameter values are not printed here.',
    );
  }
  const changeSet = await client.send(
    new DescribeChangeSetCommand({
      StackName: stackName,
      ChangeSetName: result.Id,
    }),
  );
  console.log(
    JSON.stringify(
      {
        stack: stackName,
        account,
        changeSetArn: result.Id,
        changes: changeSet.Changes?.map((change) => ({
          action: change.ResourceChange?.Action,
          resource: change.ResourceChange?.LogicalResourceId,
          type: change.ResourceChange?.ResourceType,
          replacement: change.ResourceChange?.Replacement,
        })),
      },
      null,
      2,
    ),
  );
  if (args.includes('--execute')) {
    await client.send(
      new ExecuteChangeSetCommand({
        StackName: stackName,
        ChangeSetName: result.Id,
      }),
    );
    console.log(
      `Deployment started. Check ${stackName} Events and wait for CREATE_COMPLETE/UPDATE_COMPLETE before the next stage.`,
    );
  } else
    console.log(
      'Review only: assets uploaded and change set prepared, infrastructure not executed. Execute this change set in the AWS console after reviewing it.',
    );
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Deployment failed');
  process.exitCode = 1;
});
