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
assert(
  !types(setup).some((type) => type.startsWith('AWS::ApiGateway')),
  'Provisioner must have no public API',
);
console.log(
  'All four AWS templates passed account/resource/configuration checks; no deployment performed.',
);
