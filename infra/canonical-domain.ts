/** CloudFront supplies URL-encoded query fields; retain duplicate values and encoding. */
export function canonicalDomainRedirectCode(domainName: string): string {
  return `function handler(event) {
  var request = event.request;
  var domain = ${JSON.stringify(domainName)};
  if (request.headers.host.value === domain) return request;
  var parts = [];
  Object.keys(request.querystring || {}).forEach(function (key) {
    var field = request.querystring[key];
    var values = field.multiValue || [field];
    values.forEach(function (item) { parts.push(key + '=' + item.value); });
  });
  return {
    statusCode: 308,
    statusDescription: 'Permanent Redirect',
    headers: {
      location: { value: 'https://' + domain + request.uri + (parts.length ? '?' + parts.join('&') : '') },
      'cache-control': { value: 'public, max-age=300' }
    }
  };
}`;
}
