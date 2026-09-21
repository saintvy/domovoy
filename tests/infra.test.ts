import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { validateConfig, type InfraConfig } from '../infra/config';
import { BrownieNetworkStack, WccBridgeStack } from '../infra/stacks';

const example = JSON.parse(
  readFileSync('infra/config.example.json', 'utf8'),
) as InfraConfig;

describe('AWS account boundary and cost controls', () => {
  it('rejects overlapping networks and same-account deployment', () => {
    expect(() =>
      validateConfig({ ...example, brownieVpcCidr: example.wccVpcCidr }),
    ).toThrow('overlap');
    expect(() =>
      validateConfig({ ...example, brownieAccountId: example.wccAccountId }),
    ).toThrow('different accounts');
    expect(validateConfig(example)).toBe(example);
  });
  it('creates only isolated subnets and a gateway endpoint, without fixed-cost network appliances', () => {
    const template = Template.fromStack(
      new BrownieNetworkStack(new App(), 'TestNetwork', example),
    );
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.resourceCountIs('AWS::EC2::EIP', 0);
    template.resourceCountIs('AWS::EC2::InternetGateway', 0);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::EC2::Subnet', 2);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ec2:AcceptVpcPeeringConnection',
            Resource: `arn:aws:ec2:eu-central-1:${example.brownieAccountId}:vpc-peering-connection/*`,
          }),
        ]),
      },
    });
  }, 60000);
  it('adds only peering, return routes and scoped PostgreSQL ingress to wcc', () => {
    const template = Template.fromStack(
      new WccBridgeStack(new App(), 'TestBridge', example),
    );
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::RDS::DBCluster', 0);
    template.resourceCountIs('AWS::EC2::VPC', 0);
    template.resourceCountIs('AWS::EC2::Route', 2);
    template.hasResourceProperties('AWS::EC2::VPCPeeringConnection', {
      VpcId: example.wccVpcId,
      PeerOwnerId: example.brownieAccountId,
      PeerRoleArn: { Ref: 'BrowniePeeringAccepterRoleArn' },
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: example.wccDatabaseSecurityGroupId,
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupOwnerId: example.brownieAccountId,
      SourceSecurityGroupId: { Ref: 'BrownieSecurityGroupId' },
      CidrIp: Match.absent(),
    });
    const types = Object.values(template.toJSON().Resources).map(
      (resource: any) => resource.Type,
    );
    expect(
      types.every((type) =>
        [
          'AWS::EC2::VPCPeeringConnection',
          'AWS::EC2::Route',
          'AWS::EC2::SecurityGroupIngress',
        ].includes(type),
      ),
    ).toBe(true);
  });
});
