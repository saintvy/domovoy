import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BrownieAppStack } from '../infra/stacks';
import { validateConfig, type InfraConfig } from '../infra/config';

const config = validateConfig({
  ...JSON.parse(readFileSync('infra/config.example.json', 'utf8')),
  customDomain: {
    domainName: 'domovoy.example',
    hostedZoneId: 'Z0123456789',
    certificateArn:
      'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
  },
} as InfraConfig);
const origin = 'https://domovoy.example';
const template = Template.fromStack(
  new BrownieAppStack(
    new App({ outdir: 'infra/cdk.out/domain-check' }),
    'BrownieApp',
    config,
  ),
);
template.hasResourceProperties('AWS::CloudFront::Distribution', {
  DistributionConfig: {
    Aliases: ['domovoy.example'],
    ViewerCertificate: {
      AcmCertificateArn: config.customDomain!.certificateArn,
      MinimumProtocolVersion: 'TLSv1.2_2021',
      SslSupportMethod: 'sni-only',
    },
    DefaultCacheBehavior: {
      FunctionAssociations: Match.arrayWith([
        Match.objectLike({ EventType: 'viewer-request' }),
      ]),
    },
  },
});
template.resourceCountIs('AWS::Route53::RecordSet', 2);
for (const type of ['A', 'AAAA']) {
  template.hasResourceProperties('AWS::Route53::RecordSet', {
    HostedZoneId: 'Z0123456789',
    Name: 'domovoy.example.',
    Type: type,
    AliasTarget: {
      DNSName: { 'Fn::GetAtt': ['Distribution830FAC52', 'DomainName'] },
      HostedZoneId: {
        'Fn::FindInMap': [
          'AWSCloudFrontPartitionHostedZoneIdMap',
          { Ref: 'AWS::Partition' },
          'zoneId',
        ],
      },
    },
  });
}
template.hasMapping('AWSCloudFrontPartitionHostedZoneIdMap', {
  aws: { zoneId: 'Z2FDTNDATAQYW2' },
  'aws-cn': { zoneId: 'Z3RFFRIM2A3IF5' },
});
template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
  CallbackURLs: [origin + '/'],
  LogoutURLs: [origin + '/'],
});
template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
  CallbackURLs: ['http://127.0.0.1:5173/'],
  LogoutURLs: ['http://127.0.0.1:5173/'],
});
template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
  CorsConfiguration: { AllowOrigins: [origin] },
});
template.hasResourceProperties('AWS::Lambda::Function', {
  Environment: { Variables: Match.objectLike({ APP_ORIGIN: origin }) },
});
template.hasOutput('AppUrl', { Value: origin + '/' });
console.log(
  'Custom-domain DNS, TLS, redirects, OAuth and API origin checks passed.',
);
