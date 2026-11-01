import { describe, it, expect } from 'vitest';
import { buildVerifyBody } from '../../src/lib/paypal/webhooks';

const headers = {
  auth_algo: 'SHA256withRSA',
  cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
  transmission_id: '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  transmission_sig: 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
  transmission_time: '2026-10-28T12:00:00Z',
};

// Deliberately odd formatting: whitespace, key order, unicode escape, trailing float zero.
const RAW =
  '{ "id":"WH-58D329510W468432D-8HN650336L201105X",\n  "event_type" : "CUSTOMER.DISPUTE.CREATED",' +
  '"resource":{"dispute_id":"PP-D-27803","dispute_amount":{"currency_code":"USD","value":"64.00"},' +
  '"note":"Caf\\u00e9 order","weight":1.50}, "create_time":"2026-10-28T11:59:58.000Z"}';

describe('buildVerifyBody', () => {
  it('splices the raw body verbatim as webhook_event', () => {
    const body = buildVerifyBody({ ...headers, webhook_id: '1JE4291016473214C', raw_body: RAW });
    expect(body).toContain(`"webhook_event":${RAW}`);
  });

  it('does not re-serialize the raw event', () => {
    const body = buildVerifyBody({ ...headers, webhook_id: '1JE4291016473214C', raw_body: RAW });
    expect(body).toContain('\\u00e9');
    expect(body).toContain('1.50');
    expect(body).toContain('"event_type" : "CUSTOMER.DISPUTE.CREATED"');
    expect(body).not.toContain(JSON.stringify(JSON.parse(RAW)));
  });

  it('produces valid JSON with all required fields', () => {
    const body = buildVerifyBody({ ...headers, webhook_id: '1JE4291016473214C', raw_body: RAW });
    const parsed = JSON.parse(body);
    expect(parsed.auth_algo).toBe(headers.auth_algo);
    expect(parsed.cert_url).toBe(headers.cert_url);
    expect(parsed.transmission_id).toBe(headers.transmission_id);
    expect(parsed.transmission_sig).toBe(headers.transmission_sig);
    expect(parsed.transmission_time).toBe(headers.transmission_time);
    expect(parsed.webhook_id).toBe('1JE4291016473214C');
    expect(parsed.webhook_event).toEqual(JSON.parse(RAW));
  });

  it('escapes header values that contain quotes', () => {
    const body = buildVerifyBody({
      ...headers,
      transmission_sig: 'abc"def',
      webhook_id: 'WH1',
      raw_body: '{"id":"x"}',
    });
    expect(JSON.parse(body).transmission_sig).toBe('abc"def');
  });
});