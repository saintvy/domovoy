import { App } from 'aws-cdk-lib';
import { readConfig } from './config';
import {
  BrownieNetworkStack,
  WccBridgeStack,
  BrownieAppStack,
  BrownieDatabaseSetupStack,
} from './stacks';

const app = new App();
const configPath = app.node.tryGetContext('config');
if (typeof configPath !== 'string')
  throw new Error(
    'Pass -c config=infra/config.local.json (copy and fill config.example.json first)',
  );
const config = readConfig(configPath);
const target = app.node.tryGetContext('target') ?? 'all';
if (!['network', 'bridge', 'app', 'database', 'all'].includes(target))
  throw new Error('target must be network, bridge, app, database, or all');
if (target === 'network' || target === 'all')
  new BrownieNetworkStack(app, 'BrownieNetwork', config);
if (target === 'bridge' || target === 'all')
  new WccBridgeStack(app, 'WccBrownieBridge', config);
if (target === 'app' || target === 'all')
  new BrownieAppStack(app, 'BrownieApp', config);
if (target === 'database' || target === 'all')
  new BrownieDatabaseSetupStack(app, 'BrownieDatabaseSetup', config);
