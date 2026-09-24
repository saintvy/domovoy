import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

for (const target of ['network', 'bridge', 'app', 'database']) {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'infra/deploy.ts',
      '--target',
      target,
      '--config',
      'infra/config.example.json',
      '--synth-only',
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
const load = (target, name) =>
  JSON.parse(
    readFileSync(`infra/cdk.out/${target}/${name}.template.json`, 'utf8'),
  );
const app = load('app', 'BrownieApp'),
  setup = load('database', 'BrownieDatabaseSetup');
const types = (template) =>
  Object.values(template.Resources).map((resource) => resource.Type);
for (const template of [
  app,
  setup,
  load('network', 'BrownieNetwork'),
  load('bridge', 'WccBrownieBridge'),
]) {
  for (const type of [
    'AWS::RDS::DBInstance',
    'AWS::RDS::DBCluster',
    'AWS::RDS::DBProxy',
    'AWS::EC2::NatGateway',
    'AWS::EC2::Instance',
    'AWS::EC2::EIP',
    'AWS::SecretsManager::Secret',
  ])
    assert(
      !types(template).includes(type),
      `Unexpected standing resource: ${type}`,
    );
}
assert.equal(app.Parameters.DatabasePassword.NoEcho, true);
assert.equal(app.Parameters.GoogleClientSecret.NoEcho, true);
assert.equal(setup.Parameters.WccDatabaseAdminPassword.NoEcho, true);
const entries = Object.entries(app.Resources);
const jwtAuthorizers = entries.filter(
  ([, resource]) => resource.Type === 'AWS::ApiGatewayV2::Authorizer',
);
assert.equal(jwtAuthorizers.length, 1);
assert.equal(jwtAuthorizers[0][1].Properties.AuthorizerType, 'JWT');
// gatewayGoogleIdentity restores nested claims from this exact verified header.
assert.deepEqual(jwtAuthorizers[0][1].Properties.IdentitySource, [
  '$request.header.Authorization',
]);
assert.equal(
  app.Resources.ApiPreflight.Properties.RouteKey,
  'OPTIONS /api/{proxy+}',
);
assert.equal(app.Resources.ApiPreflight.Properties.AuthorizationType, 'NONE');
assert(
  app.Resources.ApiPreflight.Properties.Target,
  'Preflight needs an integration',
);
const site = entries.find(
  ([id]) =>
    id.startsWith('PublishSite') &&
    app.Resources[id].Type === 'Custom::CDKBucketDeployment',
);
const runtime = entries.find(
  ([id]) =>
    id.startsWith('PublishRuntimeConfig') &&
    app.Resources[id].Type === 'Custom::CDKBucketDeployment',
);
assert(
  site && runtime,
  'Both site and runtime configuration deployments are required',
);
assert(
  runtime[1].DependsOn?.includes(site[0]),
  'Runtime config must be published after static assets',
);
assert(
  JSON.stringify(runtime[1].Properties).includes('/api'),
  'Public runtime config must include the API route prefix',
);
const api = entries.find(
  ([id, resource]) =>
    id.startsWith('ApiFunction') && resource.Type === 'AWS::Lambda::Function',
)[1];
assert.equal(api.Properties.ReservedConcurrentExecutions, 2);
assert.equal(api.Properties.Environment.Variables.PGDATABASE, 'brownie');
assert(
  api.Properties.VpcConfig,
  'Runtime must access RDS through the private VPC',
);
assert(
  types(app).includes('AWS::Events::Rule'),
  'Scheduled maintenance is required',
);
const lambdaByPrefix = (prefix) =>
  entries.find(
    ([id, resource]) =>
      id.startsWith(prefix) && resource.Type === 'AWS::Lambda::Function',
  );
const [telegramBridgeId, telegramBridge] = lambdaByPrefix('TelegramBridge');
const [telegramWorkerId, telegramWorker] = lambdaByPrefix('TelegramWorker');
assert(
  telegramBridge.Properties.VpcConfig,
  'Telegram bridge must remain private',
);
assert.equal(telegramBridge.Properties.ReservedConcurrentExecutions, 1);
assert.equal(telegramWorker.Properties.VpcConfig, undefined);
assert(
  !Object.keys(telegramWorker.Properties.Environment.Variables).some((key) =>
    key.startsWith('PG'),
  ),
  'Internet worker must have no database configuration',
);
assert.equal(
  telegramWorker.Properties.Environment.Variables.TELEGRAM_BOT_TOKEN_PARAMETER,
  '/domovoy/telegram/bot-token',
);
assert.equal(
  telegramWorker.Properties.Environment.Variables
    .TELEGRAM_WEBHOOK_SECRET_PARAMETER,
  '/domovoy/telegram/webhook-secret',
);
const telegramRule = entries.find(
  ([id, resource]) =>
    id.startsWith('HourlyTelegramReports') &&
    resource.Type === 'AWS::Events::Rule',
)[1];
assert.equal(telegramRule.Properties.ScheduleExpression, 'cron(0 * * * ? *)');
assert.equal(
  telegramRule.Properties.State,
  'DISABLED',
  'Example rollout must remain disabled until migration',
);
const webhook = entries.find(
  ([, resource]) =>
    resource.Type === 'AWS::ApiGatewayV2::Route' &&
    resource.Properties.RouteKey === 'POST /api/telegram/webhook',
)[1];
assert.equal(webhook.Properties.AuthorizationType, 'NONE');
const financialRoute = entries.find(
  ([, resource]) =>
    resource.Type === 'AWS::ApiGatewayV2::Route' &&
    resource.Properties.RouteKey === 'ANY /api/{proxy+}',
)[1];
assert.equal(financialRoute.Properties.AuthorizationType, 'JWT');
const localeRoute = entries.find(
  ([, resource]) =>
    resource.Type === 'AWS::ApiGatewayV2::Route' &&
    resource.Properties.RouteKey === 'GET /api/locale',
)[1];
assert.equal(localeRoute.Properties.AuthorizationType, 'NONE');
const localeApiId = localeRoute.Properties.ApiId.Ref;
assert.equal(
  app.Resources[localeApiId].Properties.CorsConfiguration,
  undefined,
);
assert.equal(
  entries.filter(
    ([, resource]) =>
      resource.Type === 'AWS::ApiGatewayV2::Route' &&
      resource.Properties.ApiId.Ref === localeApiId,
  ).length,
  1,
);
const localePolicy = entries.find(
  ([id, resource]) =>
    id.startsWith('LocaleCountryPolicy') &&
    resource.Type === 'AWS::CloudFront::OriginRequestPolicy',
);
assert.deepEqual(
  localePolicy[1].Properties.OriginRequestPolicyConfig.HeadersConfig,
  {
    HeaderBehavior: 'whitelist',
    Headers: ['CloudFront-Viewer-Country'],
  },
);
const distribution = entries.find(
  ([, resource]) => resource.Type === 'AWS::CloudFront::Distribution',
)[1];
const localeBehavior =
  distribution.Properties.DistributionConfig.CacheBehaviors.find(
    (behavior) => behavior.PathPattern === '/api/locale',
  );
assert.equal(
  localeBehavior.CachePolicyId,
  '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
); // AWS CachingDisabled
assert.deepEqual(localeBehavior.OriginRequestPolicyId, {
  Ref: localePolicy[0],
});
const workerPolicy = entries.find(
  ([id, resource]) =>
    id.startsWith('TelegramWorkerServiceRoleDefaultPolicy') &&
    resource.Type === 'AWS::IAM::Policy',
)[1].Properties.PolicyDocument.Statement;
const invocation = workerPolicy.filter((statement) =>
  [statement.Action].flat().includes('lambda:InvokeFunction'),
);
assert.equal(invocation.length, 1);
assert(JSON.stringify(invocation[0].Resource).includes(telegramBridgeId));
assert(!JSON.stringify(workerPolicy).includes('ApiFunction'));
const ssmPolicy = workerPolicy.filter((statement) =>
  [statement.Action].flat().includes('ssm:GetParameter'),
);
assert.equal(ssmPolicy.length, 1);
assert.deepEqual(ssmPolicy[0].Resource, [
  'arn:aws:ssm:eu-central-1:111111111111:parameter/domovoy/telegram/bot-token',
  'arn:aws:ssm:eu-central-1:111111111111:parameter/domovoy/telegram/webhook-secret',
]);
assert(!JSON.stringify(telegramWorker).includes('DatabasePassword'));
assert(telegramWorkerId);
assert(
  !types(setup).some((type) => type.startsWith('AWS::ApiGateway')),
  'Provisioner must have no public API',
);
console.log(
  'All four AWS templates passed account/resource/configuration checks; no deployment performed.',
);
