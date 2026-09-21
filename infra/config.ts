import { readFileSync } from 'node:fs';

/** Deployment identifiers only. Never put passwords or Google client secrets here. */
export interface InfraConfig {
  region: string;
  brownieAccountId: string;
  wccAccountId: string;
  brownieVpcCidr: string;
  availabilityZones: string[];
  wccVpcId: string;
  wccVpcCidr: string;
  wccRouteTableIds: string[];
  wccDatabaseSecurityGroupId: string;
  databaseHost: string;
  databaseName: string;
  databaseUser: string;
  /** Accepted for old deployment files; new households choose their own head on creation. */
  bootstrapAdminEmail?: string;
  invitationSenderEmail?: string;
  googleClientId: string;
  cognitoDomainPrefix: string;
  /** Optional canonical website domain; the ACM certificate must be in us-east-1. */
  customDomain?: {
    domainName: string;
    hostedZoneId: string;
    certificateArn: string;
  };
}

function cidrBounds(cidr: string): [number, number] {
  const [address, prefix] = cidr.split('/');
  const parts = address.split('.').map(Number);
  const bits = Number(prefix);
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255) ||
    !Number.isInteger(bits) ||
    bits < 16 ||
    bits > 28
  )
    throw new Error(`Invalid IPv4 VPC CIDR: ${cidr}`);
  const ip = parts.reduce((n, p) => n * 256 + p, 0);
  const size = 2 ** (32 - bits);
  if (ip % size !== 0)
    throw new Error(`CIDR is not a network address: ${cidr}`);
  return [ip, ip + size - 1];
}

export function validateConfig(config: InfraConfig): InfraConfig {
  for (const name of ['brownieAccountId', 'wccAccountId'] as const)
    if (!/^\d{12}$/.test(config[name]))
      throw new Error(`${name} must be a 12-digit AWS account ID`);
  if (config.brownieAccountId === config.wccAccountId)
    throw new Error('Brownie and wcc must use different accounts');
  if (!/^\w+-\w+-\d+$/.test(config.region) || config.region.startsWith('cn-'))
    throw new Error('Use a commercial AWS region in the aws partition');
  if (
    config.availabilityZones.length < 1 ||
    config.availabilityZones.length > 2 ||
    config.availabilityZones.some((z) => !z.startsWith(config.region))
  )
    throw new Error(
      'Supply one or two Brownie availability zones in the RDS region',
    );
  const [a, b] = cidrBounds(config.brownieVpcCidr),
    [c, d] = cidrBounds(config.wccVpcCidr);
  if (a <= d && c <= b)
    throw new Error(
      'Brownie and wcc VPC CIDRs overlap: VPC peering is impossible',
    );
  if (
    !/^vpc-[a-f0-9]+$/.test(config.wccVpcId) ||
    !/^sg-[a-f0-9]+$/.test(config.wccDatabaseSecurityGroupId)
  )
    throw new Error('Supply existing wcc VPC and RDS security group IDs');
  if (
    !config.wccRouteTableIds.length ||
    config.wccRouteTableIds.some((id) => !/^rtb-[a-f0-9]+$/.test(id))
  )
    throw new Error('Supply route tables for every existing RDS subnet');
  if (
    !/^brownie(?:_[a-z0-9_]+)?$/.test(config.databaseName) ||
    config.databaseName.length > 40 ||
    !/^brownie_[a-z0-9_]+$/.test(config.databaseUser) ||
    config.databaseUser.length > 63
  )
    throw new Error(
      'Use a separate brownie database and brownie_ runtime login',
    );
  if (
    !config.databaseHost.endsWith(`.${config.region}.rds.amazonaws.com`) &&
    !config.databaseHost.endsWith('.rds.amazonaws.com')
  )
    throw new Error('Supply the existing RDS endpoint hostname');
  if (
    config.invitationSenderEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.invitationSenderEmail)
  )
    throw new Error('Supply a valid SES sender email');
  if (!config.googleClientId.endsWith('.apps.googleusercontent.com'))
    throw new Error('Supply a Google OAuth web client ID');
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.cognitoDomainPrefix)
  )
    throw new Error('Invalid Cognito domain prefix');
  if (config.customDomain) {
    const { domainName, hostedZoneId, certificateArn } = config.customDomain;
    if (
      typeof domainName !== 'string' ||
      domainName.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        domainName,
      )
    )
      throw new Error(
        'Use a lowercase DNS hostname without a scheme, path or wildcard',
      );
    if (!/^Z[A-Z0-9]+$/.test(hostedZoneId))
      throw new Error(
        'Supply the public Route 53 hosted zone ID without /hostedzone/',
      );
    if (
      !new RegExp(
        `^arn:aws:acm:us-east-1:${config.brownieAccountId}:certificate/[a-f0-9-]{36}$`,
      ).test(certificateArn)
    )
      throw new Error(
        'CloudFront requires an ACM certificate in us-east-1 in the application account',
      );
  }
  return config;
}

export function readConfig(file: string): InfraConfig {
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')) as InfraConfig);
}
