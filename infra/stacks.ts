import { resolve } from 'node:path';
import {
  Stack,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  SecretValue,
  Tags,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3notifications from 'aws-cdk-lib/aws-s3-notifications';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import type { InfraConfig } from './config';
import { canonicalDomainRedirectCode } from './canonical-domain';

const networkExport = (key: string) => `BrownieNetwork:${key}`;
function tag(stack: Stack, config: InfraConfig) {
  Tags.of(stack).add('project', 'brownie');
  // All IDs/AZs are explicitly configured; synthesis must not require AWS credentials.
  stack.node.setContext(
    `availability-zones:account=${stack.account}:region=${stack.region}`,
    config.availabilityZones,
  );
}
function output(
  stack: Stack,
  name: string,
  value: string,
  exportName?: string,
) {
  new CfnOutput(stack, name, { value, exportName });
}

/** Stage 1, Brownie account. This stack has no dependencies on the wcc deployment. */
export class BrownieNetworkStack extends Stack {
  constructor(scope: Construct, id: string, config: InfraConfig) {
    super(scope, id, {
      env: { account: config.brownieAccountId, region: config.region },
    });
    tag(this, config);
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.brownieVpcCidr),
      availabilityZones: config.availabilityZones,
      natGateways: 0,
      createInternetGateway: false,
      subnetConfiguration: [
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
    });
    const sg = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Brownie API: private PostgreSQL and S3 only',
    });
    sg.addEgressRule(
      ec2.Peer.ipv4(config.wccVpcCidr),
      ec2.Port.tcp(5432),
      'PostgreSQL in the peered wcc VPC',
    );
    // There is no internet/default route. HTTPS reaches S3 only through the gateway endpoint.
    sg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'S3 gateway endpoint; no NAT or internet route',
    );
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    const acceptRole = new iam.Role(this, 'PeeringAccepterRole', {
      assumedBy: new iam.AccountPrincipal(config.wccAccountId),
      description:
        'Allows wcc CloudFormation to accept peering to the Brownie VPC; no database permissions',
    });
    acceptRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:AcceptVpcPeeringConnection'],
        resources: [
          `arn:aws:ec2:${config.region}:${config.brownieAccountId}:vpc-peering-connection/*`,
        ],
        conditions: {
          StringEquals: {
            'ec2:AccepterVpc': `arn:aws:ec2:${config.region}:${config.brownieAccountId}:vpc/${vpc.vpcId}`,
          },
        },
      }),
    );
    acceptRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:AcceptVpcPeeringConnection'],
        resources: [
          `arn:aws:ec2:${config.region}:${config.brownieAccountId}:vpc/${vpc.vpcId}`,
        ],
      }),
    );
    output(this, 'VpcId', vpc.vpcId, networkExport('VpcId'));
    output(
      this,
      'ApiSecurityGroupId',
      sg.securityGroupId,
      networkExport('ApiSecurityGroupId'),
    );
    output(this, 'PeeringAccepterRoleArn', acceptRole.roleArn);
    for (const [index, subnet] of vpc.isolatedSubnets.entries()) {
      output(
        this,
        `Subnet${index}Id`,
        subnet.subnetId,
        networkExport(`Subnet${index}Id`),
      );
      output(
        this,
        `RouteTable${index}Id`,
        subnet.routeTable.routeTableId,
        networkExport(`RouteTable${index}Id`),
      );
    }
  }
}

/** Stage 2, wcc account. Owns only new peering/routes/ingress; never the RDS instance. */
export class WccBridgeStack extends Stack {
  constructor(scope: Construct, id: string, config: InfraConfig) {
    super(scope, id, {
      env: { account: config.wccAccountId, region: config.region },
    });
    tag(this, config);
    const peerVpc = new CfnParameter(this, 'BrownieVpcId', {
      type: 'String',
      allowedPattern: 'vpc-[a-f0-9]+',
    });
    const peerSg = new CfnParameter(this, 'BrownieSecurityGroupId', {
      type: 'String',
      allowedPattern: 'sg-[a-f0-9]+',
    });
    const peerRole = new CfnParameter(this, 'BrowniePeeringAccepterRoleArn', {
      type: 'String',
      allowedPattern: `arn:aws:iam::${config.brownieAccountId}:role/.+`,
    });
    const peering = new ec2.CfnVPCPeeringConnection(this, 'Peering', {
      vpcId: config.wccVpcId,
      peerVpcId: peerVpc.valueAsString,
      peerOwnerId: config.brownieAccountId,
      peerRegion: config.region,
      peerRoleArn: peerRole.valueAsString,
      tags: [{ key: 'Name', value: 'wcc-brownie-private-postgres' }],
    });
    for (const [index, routeTableId] of config.wccRouteTableIds.entries())
      new ec2.CfnRoute(this, `ReturnRoute${index}`, {
        routeTableId,
        destinationCidrBlock: config.brownieVpcCidr,
        vpcPeeringConnectionId: peering.ref,
      });
    const ingress = new ec2.CfnSecurityGroupIngress(
      this,
      'BrowniePostgresIngress',
      {
        groupId: config.wccDatabaseSecurityGroupId,
        ipProtocol: 'tcp',
        fromPort: 5432,
        toPort: 5432,
        sourceSecurityGroupId: peerSg.valueAsString,
        sourceSecurityGroupOwnerId: config.brownieAccountId,
        description:
          'Brownie Lambda over same-region cross-account VPC peering',
      },
    );
    ingress.addResourceDependency(peering);
    output(this, 'PeeringConnectionId', peering.ref);
  }
}

/** Stage 3, Brownie account. No RDS, EC2, NAT, provisioned concurrency, or RDS Proxy. */
export class BrownieAppStack extends Stack {
  constructor(scope: Construct, id: string, config: InfraConfig) {
    super(scope, id, {
      env: { account: config.brownieAccountId, region: config.region },
    });
    tag(this, config);
    const peering = new CfnParameter(this, 'PeeringConnectionId', {
      type: 'String',
      allowedPattern: 'pcx-[a-f0-9]+',
    });
    const dbPassword = new CfnParameter(this, 'DatabasePassword', {
      type: 'String',
      noEcho: true,
      minLength: 20,
      description:
        'Password of the dedicated Brownie runtime PostgreSQL login; never the wcc owner/master password',
    });
    const googleSecret = new CfnParameter(this, 'GoogleClientSecret', {
      type: 'String',
      noEcho: true,
      minLength: 10,
    });
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Network', {
      vpcId: Fn.importValue(networkExport('VpcId')),
      availabilityZones: config.availabilityZones,
      isolatedSubnetIds: config.availabilityZones.map((_, i) =>
        Fn.importValue(networkExport(`Subnet${i}Id`)),
      ),
      isolatedSubnetRouteTableIds: config.availabilityZones.map((_, i) =>
        Fn.importValue(networkExport(`RouteTable${i}Id`)),
      ),
    });
    for (const [index] of config.availabilityZones.entries())
      new ec2.CfnRoute(this, `DatabaseRoute${index}`, {
        routeTableId: Fn.importValue(networkExport(`RouteTable${index}Id`)),
        destinationCidrBlock: config.wccVpcCidr,
        vpcPeeringConnectionId: peering.valueAsString,
      });
    const apiSg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ApiSecurityGroup',
      Fn.importValue(networkExport('ApiSecurityGroupId')),
      { mutable: false },
    );
    const site = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });
    const backups = new s3.Bucket(this, 'BackupBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          abortIncompleteMultipartUploadAfter: Duration.days(1),
          noncurrentVersionExpiration: Duration.days(30),
        },
      ],
    });
    const services = new s3.Bucket(this, 'ServicesBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          prefix: 'outbox/',
          expiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          prefix: 'telegram-outbox/',
          expiration: Duration.days(2),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });
    const headers = new cloudfront.ResponseHeadersPolicy(
      this,
      'SecurityHeaders',
      {
        securityHeadersBehavior: {
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
          contentSecurityPolicy: {
            override: true,
            contentSecurityPolicy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.execute-api.${config.region}.amazonaws.com https://*.auth.${config.region}.amazoncognito.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
          },
        },
      },
    );
    const customDomain = config.customDomain;
    const canonicalRedirect = customDomain
      ? new cloudfront.Function(this, 'CanonicalDomainRedirect', {
          runtime: cloudfront.FunctionRuntime.JS_2_0,
          code: cloudfront.FunctionCode.fromInline(
            canonicalDomainRedirectCode(customDomain.domainName),
          ),
          comment:
            'Send the former CloudFront hostname to the canonical Domovoy origin',
        })
      : undefined;
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      ...(customDomain
        ? {
            domainNames: [customDomain.domainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              'WebsiteCertificate',
              customDomain.certificateArn,
            ),
            minimumProtocolVersion:
              cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            sslSupportMethod: cloudfront.SSLMethod.SNI,
          }
        : {}),
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        ...(canonicalRedirect
          ? {
              functionAssociations: [
                {
                  function: canonicalRedirect,
                  eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
                },
              ],
            }
          : {}),
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers,
        // Respect origin Cache-Control (index/config/SW are not long-lived).
        cachePolicy: new cloudfront.CachePolicy(this, 'StaticCache', {
          minTtl: Duration.seconds(0),
          defaultTtl: Duration.minutes(5),
          maxTtl: Duration.days(365),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
      },
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
    });
    if (customDomain) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(
        this,
        'WebsiteZone',
        {
          hostedZoneId: customDomain.hostedZoneId,
          zoneName: customDomain.domainName,
        },
      );
      const target = route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      );
      new route53.ARecord(this, 'WebsiteIPv4', {
        zone,
        recordName: customDomain.domainName,
        target,
      });
      new route53.AaaaRecord(this, 'WebsiteIPv6', {
        zone,
        recordName: customDomain.domainName,
        target,
      });
    }
    const origin = `https://${customDomain?.domainName ?? distribution.distributionDomainName}`;
    const pool = new cognito.UserPool(this, 'UserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.NONE,
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
      featurePlan: cognito.FeaturePlan.LITE,
    });
    const provider = new cognito.UserPoolIdentityProviderGoogle(
      this,
      'Google',
      {
        userPool: pool,
        clientId: config.googleClientId,
        clientSecretValue: SecretValue.cfnParameter(googleSecret),
        scopes: ['openid', 'email', 'profile'],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          fullname: cognito.ProviderAttribute.GOOGLE_NAME,
          emailVerified: cognito.ProviderAttribute.other('email_verified'),
        },
      },
    );
    const client = pool.addClient('BrowserClient', {
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      authFlows: {
        userPassword: false,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`${origin}/`],
        logoutUrls: [`${origin}/`],
      },
      idTokenValidity: Duration.minutes(15),
      accessTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
        fullname: true,
      }),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        fullname: true,
      }),
    });
    client.node.addDependency(provider);
    const devClient = pool.addClient('LocalBrowserClient', {
      generateSecret: false,
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      ],
      authFlows: {
        userPassword: false,
        userSrp: false,
        adminUserPassword: false,
        custom: false,
      },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['http://127.0.0.1:5173/'],
        logoutUrls: ['http://127.0.0.1:5173/'],
      },
      idTokenValidity: Duration.minutes(15),
      accessTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        emailVerified: true,
        fullname: true,
      }),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
        email: true,
        fullname: true,
      }),
    });
    devClient.node.addDependency(provider);
    const domain = pool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: config.cognitoDomainPrefix },
    });
    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const fn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: resolve('src/aws/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(28),
      reservedConcurrentExecutions: 2,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [apiSg],
      logGroup,
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        sourceMap: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        PGHOST: config.databaseHost,
        PGPORT: '5432',
        PGDATABASE: config.databaseName,
        PGUSER: config.databaseUser,
        PGPASSWORD: dbPassword.valueAsString,
        PGSSLROOTCERT: '/var/runtime/ca-cert.pem',
        NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
        COGNITO_ISSUER: pool.userPoolProviderUrl,
        COGNITO_CLIENT_ID: client.userPoolClientId,
        APP_ORIGIN: origin,
        BACKUP_BUCKET: backups.bucketName,
        SERVICES_BUCKET: services.bucketName,
        INVITATION_SENDER: config.invitationSenderEmail ?? '',
      },
    });
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3:GetObject',
          's3:GetObjectVersion',
          's3:PutObject',
          's3:DeleteObject',
        ],
        resources: [backups.arnForObjects('family/*')],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket', 's3:ListBucketVersions'],
        resources: [backups.bucketArn],
        conditions: { StringLike: { 's3:prefix': ['family/*'] } },
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:DeleteObjectVersion'],
        resources: [backups.arnForObjects('family/*')],
      }),
    );
    services.grantRead(fn, 'rates/*');
    services.grantPut(fn, 'rates-refresh/*');
    services.grantPut(fn, 'outbox/*');
    const rateWorker = new nodejs.NodejsFunction(this, 'RatesWorker', {
      entry: resolve('src/aws/rates-worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'RatesLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: { SERVICES_BUCKET: services.bucketName },
    });
    services.grantReadWrite(rateWorker, 'rates/*');
    services.grantRead(rateWorker, 'rates-refresh/*');
    services.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3notifications.LambdaDestination(rateWorker),
      { prefix: 'rates-refresh/', suffix: '.json' },
    );
    const external = new nodejs.NodejsFunction(this, 'ExternalWorker', {
      entry: resolve('src/aws/external-worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(90),
      reservedConcurrentExecutions: 1,
      logGroup: new logs.LogGroup(this, 'ExternalLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        SERVICES_BUCKET: services.bucketName,
        APP_ORIGIN: origin,
        INVITATION_SENDER: config.invitationSenderEmail ?? '',
      },
    });
    services.grantReadWrite(external, 'rates/*');
    services.grantReadWrite(external, 'outbox/*');
    if (config.invitationSenderEmail)
      external.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['ses:SendEmail'],
          resources: [
            `arn:aws:ses:${config.region}:${config.brownieAccountId}:identity/${config.invitationSenderEmail}`,
          ],
        }),
      );
    services.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3notifications.LambdaDestination(external),
      { prefix: 'outbox/', suffix: '.json' },
    );
    new events.Rule(this, 'RefreshExchangeRates', {
      schedule: events.Schedule.cron({ minute: '30', hour: '16' }),
      targets: [
        new eventTargets.LambdaFunction(rateWorker, {
          event: events.RuleTargetInput.fromObject({ action: 'refresh-rates' }),
          retryAttempts: 2,
        }),
      ],
    });
    new events.Rule(this, 'RetryInvitations', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [
        new eventTargets.LambdaFunction(external, {
          event: events.RuleTargetInput.fromObject({
            action: 'retry-invitations',
          }),
          retryAttempts: 1,
        }),
      ],
    });
    new events.Rule(this, 'HourlyMaintenance', {
      schedule: events.Schedule.rate(Duration.hours(1)),
      targets: [
        new eventTargets.LambdaFunction(fn, {
          event: events.RuleTargetInput.fromObject({ action: 'maintenance' }),
          retryAttempts: 1,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });
    const api = new apigw.HttpApi(this, 'HttpApi', {
      corsPreflight: {
        allowOrigins: [origin],
        allowMethods: [
          apigw.CorsHttpMethod.GET,
          apigw.CorsHttpMethod.POST,
          apigw.CorsHttpMethod.PATCH,
          apigw.CorsHttpMethod.DELETE,
          apigw.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['authorization', 'content-type', 'x-brownie-session'],
        maxAge: Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    const telegramBridge = new nodejs.NodejsFunction(this, 'TelegramBridge', {
      entry: resolve('src/aws/telegram-bridge.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [apiSg],
      logGroup: new logs.LogGroup(this, 'TelegramBridgeLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        PGHOST: config.databaseHost,
        PGPORT: '5432',
        PGDATABASE: config.databaseName,
        PGUSER: config.databaseUser,
        PGPASSWORD: dbPassword.valueAsString,
        PGSSLROOTCERT: '/var/runtime/ca-cert.pem',
        NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
        SERVICES_BUCKET: services.bucketName,
      },
    });
    services.grantPut(telegramBridge, 'telegram-outbox/*');
    const telegramWorker = new nodejs.NodejsFunction(this, 'TelegramWorker', {
      entry: resolve('src/aws/telegram-worker.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(45),
      reservedConcurrentExecutions: 2,
      logGroup: new logs.LogGroup(this, 'TelegramWorkerLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        SERVICES_BUCKET: services.bucketName,
        TELEGRAM_BRIDGE_FUNCTION: telegramBridge.functionName,
        TELEGRAM_BOT_TOKEN_PARAMETER: '/domovoy/telegram/bot-token',
        TELEGRAM_WEBHOOK_SECRET_PARAMETER: '/domovoy/telegram/webhook-secret',
      },
    });
    telegramBridge.grantInvoke(telegramWorker);
    services.grantDelete(telegramWorker, 'telegram-outbox/*');
    telegramWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: ['bot-token', 'webhook-secret'].map(
          (name) =>
            `arn:aws:ssm:${config.region}:${config.brownieAccountId}:parameter/domovoy/telegram/${name}`,
        ),
      }),
    );
    services.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3notifications.LambdaDestination(telegramWorker),
      { prefix: 'telegram-outbox/', suffix: '.json' },
    );
    const telegramSchedule = new events.Rule(this, 'HourlyTelegramReports', {
      enabled: config.telegramRemindersEnabled ?? false,
      schedule: events.Schedule.cron({ minute: '0', hour: '*' }),
      targets: [
        new eventTargets.LambdaFunction(telegramBridge, {
          event: events.RuleTargetInput.fromObject({
            action: 'telegram.schedule',
          }),
          retryAttempts: 2,
          maxEventAge: Duration.hours(1),
        }),
      ],
    });
    api.addRoutes({
      path: '/api/telegram/webhook',
      methods: [apigw.HttpMethod.POST],
      integration: new HttpLambdaIntegration(
        'TelegramWebhookIntegration',
        telegramWorker,
      ),
    });
    output(this, 'TelegramBridgeName', telegramBridge.functionName);
    output(this, 'TelegramWorkerName', telegramWorker.functionName);
    output(this, 'TelegramScheduleName', telegramSchedule.ruleName);
    output(
      this,
      'TelegramWebhookUrl',
      `${api.apiEndpoint}/api/telegram/webhook`,
    );
    const authorizer = new HttpJwtAuthorizer(
      'CognitoJwt',
      pool.userPoolProviderUrl,
      { jwtAudience: [client.userPoolClientId] },
    );
    // No OAuth scopes: the application intentionally accepts ID tokens and verifies token_use=id.
    api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.ANY],
      integration,
      authorizer,
    });
    // A browser preflight carries no JWT. This explicit route outranks authenticated ANY.
    const [preflight] = api.addRoutes({
      path: '/api/{proxy+}',
      methods: [apigw.HttpMethod.OPTIONS],
      integration,
    });
    (preflight.node.defaultChild as apigw.CfnRoute).overrideLogicalId(
      'ApiPreflight',
    );
    api.addRoutes({
      path: '/api/health',
      methods: [apigw.HttpMethod.GET],
      integration,
    });
    const stage = api.defaultStage?.node.defaultChild as
      apigw.CfnStage | undefined;
    if (stage)
      stage.defaultRouteSettings = {
        throttlingBurstLimit: 10,
        throttlingRateLimit: 5,
      };
    const publishSite = new s3deploy.BucketDeployment(this, 'PublishSite', {
      // The development placeholder must never overwrite the separately managed OAuth config.
      // DependsOn alone cannot rerun an unchanged PublishRuntimeConfig resource on a later release.
      sources: [
        s3deploy.Source.asset(resolve('dist'), {
          exclude: ['runtime-config.json'],
        }),
      ],
      destinationBucket: site,
      prune: false,
      cacheControl: [s3deploy.CacheControl.noCache()],
      distribution,
      distributionPaths: ['/*'],
    });
    const publishConfiguration = new s3deploy.BucketDeployment(
      this,
      'PublishRuntimeConfig',
      {
        sources: [
          s3deploy.Source.jsonData('runtime-config.json', {
            apiBaseUrl: `${api.apiEndpoint}/api`,
            cognitoDomain: domain.baseUrl(),
            cognitoClientId: client.userPoolClientId,
            cognitoUserPoolId: pool.userPoolId,
            cognitoRedirectUri: `${origin}/`,
            region: config.region,
          }),
        ],
        destinationBucket: site,
        prune: false,
        cacheControl: [s3deploy.CacheControl.noStore()],
        distribution,
        distributionPaths: ['/runtime-config.json'],
      },
    );
    publishConfiguration.node.addDependency(publishSite);
    output(this, 'AppUrl', `${origin}/`);
    output(this, 'ApiUrl', api.apiEndpoint);
    output(this, 'CognitoUserPoolId', pool.userPoolId);
    output(this, 'CognitoClientId', client.userPoolClientId);
    output(this, 'CognitoLocalClientId', devClient.userPoolClientId);
    output(this, 'ExternalWorkerName', external.functionName);
    output(this, 'RatesWorkerName', rateWorker.functionName);
    output(this, 'ServicesBucketName', services.bucketName);
    output(
      this,
      'GoogleAuthorizedRedirectUri',
      `${domain.baseUrl()}/oauth2/idpresponse`,
    );
    output(this, 'ApiFunctionName', fn.functionName);
    output(this, 'SiteBucketName', site.bucketName);
    output(this, 'BackupBucketName', backups.bucketName);
  }
}

/** Temporary, manually invoked migration tool. Delete this stack after provisioning. */
export class BrownieDatabaseSetupStack extends Stack {
  constructor(scope: Construct, id: string, config: InfraConfig) {
    super(scope, id, {
      env: { account: config.brownieAccountId, region: config.region },
    });
    tag(this, config);
    const admin = new CfnParameter(this, 'WccDatabaseAdminUser', {
      type: 'String',
    });
    const adminPassword = new CfnParameter(this, 'WccDatabaseAdminPassword', {
      type: 'String',
      noEcho: true,
    });
    const password = new CfnParameter(this, 'DatabasePassword', {
      type: 'String',
      noEcho: true,
      minLength: 20,
    });
    const vpc = ec2.Vpc.fromVpcAttributes(this, 'Network', {
      vpcId: Fn.importValue(networkExport('VpcId')),
      availabilityZones: config.availabilityZones,
      isolatedSubnetIds: config.availabilityZones.map((_, i) =>
        Fn.importValue(networkExport(`Subnet${i}Id`)),
      ),
      isolatedSubnetRouteTableIds: config.availabilityZones.map((_, i) =>
        Fn.importValue(networkExport(`RouteTable${i}Id`)),
      ),
    });
    const sg = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'SecurityGroup',
      Fn.importValue(networkExport('ApiSecurityGroupId')),
      { mutable: false },
    );
    const fn = new nodejs.NodejsFunction(this, 'Provisioner', {
      entry: resolve('infra/provision-database.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(60),
      reservedConcurrentExecutions: 1,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [sg],
      logGroup: new logs.LogGroup(this, 'SetupLogs', {
        retention: logs.RetentionDays.ONE_DAY,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: {
        format: nodejs.OutputFormat.ESM,
        target: 'node22',
        minify: true,
        externalModules: [],
        banner:
          "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      },
      environment: {
        PGHOST: config.databaseHost,
        PGPORT: '5432',
        PGDATABASE: config.databaseName,
        PGUSER: admin.valueAsString,
        PGPASSWORD: adminPassword.valueAsString,
        PGSSLROOTCERT: '/var/runtime/ca-cert.pem',
        NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
        BROWNIE_RUNTIME_USER: config.databaseUser,
        BROWNIE_RUNTIME_PASSWORD: password.valueAsString,
      },
    });
    output(this, 'DatabaseSetupFunctionName', fn.functionName);
  }
}
