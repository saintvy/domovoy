import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { validateConfig, type InfraConfig } from '../infra/config';
import { canonicalDomainRedirectCode } from '../infra/canonical-domain';

const example = JSON.parse(
  readFileSync('infra/config.example.json', 'utf8'),
) as InfraConfig;
const domain = {
  domainName: 'domovoy.example',
  hostedZoneId: 'Z0123456789',
  certificateArn:
    'arn:aws:acm:us-east-1:111111111111:certificate/00000000-0000-0000-0000-000000000000',
};

describe('custom website domain', () => {
  it('requires a hostname and a CloudFront certificate in the correct account and region', () => {
    expect(
      validateConfig({ ...example, customDomain: domain }).customDomain,
    ).toEqual(domain);
    for (const patch of [
      { domainName: 'https://domovoy.example' },
      { domainName: 'domovoy.example/path' },
      { domainName: '*.domovoy.example' },
      { hostedZoneId: '/hostedzone/Z0123456789' },
      {
        certificateArn: domain.certificateArn.replace(
          'us-east-1',
          'eu-central-1',
        ),
      },
      {
        certificateArn: domain.certificateArn.replace(
          '111111111111',
          '222222222222',
        ),
      },
    ])
      expect(() =>
        validateConfig({ ...example, customDomain: { ...domain, ...patch } }),
      ).toThrow();
    expect(validateConfig(example)).toBe(example);
  });

  const handler = runInNewContext(
    canonicalDomainRedirectCode(domain.domainName) + '\nhandler;',
  );
  it('leaves requests on the canonical hostname untouched', () => {
    const request = {
      headers: { host: { value: domain.domainName } },
      uri: '/',
      querystring: {},
    };
    expect(handler({ request })).toBe(request);
  });
  it('redirects the former hostname while preserving paths and encoded repeated query values', () => {
    const result = handler({
      request: {
        headers: { host: { value: 'old.cloudfront.net' } },
        uri: '/settings',
        querystring: {
          code: { value: 'a%2Bb' },
          tag: { multiValue: [{ value: 'one' }, { value: 'two%20words' }] },
        },
      },
    });
    expect(result.statusCode).toBe(308);
    expect(result.headers.location.value).toBe(
      'https://domovoy.example/settings?code=a%2Bb&tag=one&tag=two%20words',
    );
    expect(
      handler({
        request: {
          headers: { host: { value: 'old.cloudfront.net' } },
          uri: '/',
        },
      }).headers.location.value,
    ).toBe('https://domovoy.example/');
  });
});
