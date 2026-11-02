import { describe, it, expect } from 'vitest';
import { buildVerifyBody, verifyWebhookSignature } from '../../src/lib/paypal/webhooks';
import { getDb } from '../../src/lib/db';

const headers = {
  auth_algo: 'SHA256withRSA',
  cert_url: 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77',
  transmission_id: '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
  transmission_sig: 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
  transmission_time: '2026-10-28T12:00:00Z',
};

/** The same five values as the HTTP headers PayPal sends with a webhook. */
const httpHeaders = {
  'paypal-auth-algo': headers.auth_algo,
  'paypal-cert-url': headers.cert_url,
  'paypal-transmission-id': headers.transmission_id,
  'paypal-transmission-sig': headers.transmission_sig,
  'paypal-transmission-time': headers.transmission_time,
};

const WEBHOOK_ID = '1JE4291016473214C';

// Deliberately odd formatting: whitespace, key order, unicode escape, trailing float zero.
const RAW =
  '{ "id":"WH-58D329510W468432D-8HN650336L201105X",\n  "event_type" : "CUSTOMER.DISPUTE.CREATED",' +
  '"resource":{"dispute_id":"PP-D-27803","dispute_amount":{"currency_code":"USD","value":"64.00"},' +
  '"note":"Caf\\u00e9 order","weight":1.50}, "create_time":"2026-10-28T11:59:58.000Z"}';

describe('buildVerifyBody', () => {
  it('splices the raw body verbatim as webhook_event', () => {
    const body = buildVerifyBody(RAW, headers, WEBHOOK_ID);
    expect(body).toContain(`"webhook_event":${RAW}`);
    expect(body.endsWith(`"webhook_event":${RAW}}`)).toBe(true);
  });

  it('does not re-serialize the raw event', () => {
    const body = buildVerifyBody(RAW, headers, WEBHOOK_ID);
    expect(body).toContain('\\u00e9');
    expect(body).toContain('1.50');
    expect(body).toContain('"event_type" : "CUSTOMER.DISPUTE.CREATED"');
    expect(body).not.toContain(JSON.stringify(JSON.parse(RAW)));
  });

  it('produces valid JSON with all required fields', () => {
    const parsed = JSON.parse(buildVerifyBody(RAW, headers, WEBHOOK_ID));
    expect(parsed.auth_algo).toBe(headers.auth_algo);
    expect(parsed.cert_url).toBe(headers.cert_url);
    expect(parsed.transmission_id).toBe(headers.transmission_id);
    expect(parsed.transmission_sig).toBe(headers.transmission_sig);
    expect(parsed.transmission_time).toBe(headers.transmission_time);
    expect(parsed.webhook_id).toBe(WEBHOOK_ID);
    expect(parsed.webhook_event).toEqual(JSON.parse(RAW));
  });

  it('reads the values from raw PayPal HTTP headers as well', () => {
    expect(buildVerifyBody(RAW, new Headers(httpHeaders), WEBHOOK_ID)).toBe(buildVerifyBody(RAW, headers, WEBHOOK_ID));
  });

  it('escapes header values that contain quotes', () => {
    const body = buildVerifyBody('{"id":"x"}', { ...headers, transmission_sig: 'abc"def' }, 'WH1');
    expect(JSON.parse(body).transmission_sig).toBe('abc"def');
  });

  it('refuses a body that is not a JSON object, missing headers, or no webhook id', () => {
    expect(() => buildVerifyBody('[1,2]', headers, WEBHOOK_ID)).toThrow(/JSON object/);
    expect(() => buildVerifyBody('{"id":', headers, WEBHOOK_ID)).toThrow();
    expect(() => buildVerifyBody(RAW, { 'paypal-auth-algo': 'SHA256withRSA' }, WEBHOOK_ID)).toThrow(/headers/);
    expect(() => buildVerifyBody(RAW, headers, '')).toThrow(/PAYPAL_WEBHOOK_ID/);
  });
});

describe('verifyWebhookSignature (PAYPAL_MOCK=1)', () => {
  const verifyCalls = () =>
    getDb()
      .prepare(`SELECT dispute_id, method, status_code, debug_id FROM paypal_calls WHERE path = '/v1/notifications/verify-webhook-signature'`)
      .all() as { dispute_id: string | null; method: string; status_code: number; debug_id: string | null }[];

  it('verifies through the logged PayPal client, so the call shows on the Activity page', async () => {
    const before = verifyCalls().length;
    const res = await verifyWebhookSignature(RAW, httpHeaders, { webhookId: WEBHOOK_ID });
    expect(res).toMatchObject({ verified: true, verification_status: 'SUCCESS', status_code: 200 });
    expect(res.debug_id).toMatch(/^mock-/);

    const calls = verifyCalls();
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toEqual({ dispute_id: 'PP-D-27803', method: 'POST', status_code: 200, debug_id: res.debug_id });
  });

  it('fails without calling PayPal when headers are missing or the body is not an event', async () => {
    const before = verifyCalls().length;
    expect(await verifyWebhookSignature(RAW, {}, { webhookId: WEBHOOK_ID })).toMatchObject({ verified: false, status_code: null });
    expect(await verifyWebhookSignature('{"hello":"world"}', httpHeaders, { webhookId: WEBHOOK_ID })).toMatchObject({
      verified: false,
      error: 'Body is not a PayPal event',
    });
    expect(verifyCalls()).toHaveLength(before);
  });
});
