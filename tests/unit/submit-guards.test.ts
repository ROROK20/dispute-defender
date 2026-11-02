import { describe, it, expect } from 'vitest';
import {
  MAX_PDF_BYTES,
  buildEvidences,
  checkSubmissionGuards,
  type GuardInput,
} from '../../src/lib/submit-guards';

const NOW = new Date('2026-10-28T12:00:00Z');
const MB = 1024 * 1024;
const DUE = '2026-11-07T23:59:59Z';

/** The checks run against the dispute as just re-fetched from PayPal. */
const good: GuardInput = {
  source: 'paypal_sandbox',
  paypalStatus: 'WAITING_FOR_SELLER_RESPONSE',
  dueAt: DUE,
  now: NOW,
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  evidenceTypes: ['PROOF_OF_FULFILLMENT'],
  pdfBytes: 300 * 1024,
};

describe('checkSubmissionGuards', () => {
  it('passes a valid submission', () => {
    expect(checkSubmissionGuards(good)).toEqual({ ok: true });
  });

  it('rejects fixture disputes with FIXTURE_READ_ONLY', () => {
    expect(checkSubmissionGuards({ ...good, source: 'fixture' })).toMatchObject({ ok: false, code: 'FIXTURE_READ_ONLY', httpStatus: 422 });
  });

  it('rejects disputes not waiting for seller response', () => {
    for (const paypalStatus of ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'WAITING_FOR_BUYER_RESPONSE', undefined]) {
      expect(checkSubmissionGuards({ ...good, paypalStatus })).toMatchObject({ ok: false, code: 'INVALID_STATE', httpStatus: 409 });
    }
  });

  it('rejects submissions after the seller response deadline', () => {
    const r = checkSubmissionGuards({ ...good, now: new Date('2026-11-08T00:00:00Z') });
    expect(r).toMatchObject({ ok: false, code: 'DEADLINE_PASSED', httpStatus: 409 });
  });

  it('rejects at exactly the deadline', () => {
    expect(checkSubmissionGuards({ ...good, now: new Date(DUE) })).toMatchObject({ ok: false, code: 'DEADLINE_PASSED' });
    expect(checkSubmissionGuards({ ...good, now: new Date(Date.parse(DUE) - 1) })).toEqual({ ok: true });
  });

  it('rejects evidence types not allowed for the reason code', () => {
    const r = checkSubmissionGuards({ ...good, evidenceTypes: ['PROOF_OF_FULFILLMENT', 'RETURN_POLICY'] });
    expect(r).toMatchObject({ ok: false, code: 'EVIDENCE_TYPE_NOT_ALLOWED', httpStatus: 422 });
    expect(checkSubmissionGuards({ ...good, evidenceTypes: ['SOMETHING_INVENTED'] })).toMatchObject({ ok: false, code: 'EVIDENCE_TYPE_NOT_ALLOWED' });
    expect(
      checkSubmissionGuards({ ...good, reason: 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED', evidenceTypes: ['ITEM_DESCRIPTION', 'RETURN_POLICY'] }),
    ).toEqual({ ok: true });
  });

  it('rejects an empty evidence list', () => {
    expect(checkSubmissionGuards({ ...good, evidenceTypes: [] })).toMatchObject({ ok: false, code: 'NO_EVIDENCE' });
  });

  it('rejects PDFs of 10 MB or more', () => {
    expect(MAX_PDF_BYTES).toBe(10 * MB);
    expect(checkSubmissionGuards({ ...good, pdfBytes: 10 * MB })).toMatchObject({ ok: false, code: 'PDF_TOO_LARGE' });
    expect(checkSubmissionGuards({ ...good, pdfBytes: 10 * MB - 1 })).toEqual({ ok: true });
  });

  it('rejects an empty PDF', () => {
    expect(checkSubmissionGuards({ ...good, pdfBytes: 0 })).toMatchObject({ ok: false, code: 'PDF_EMPTY' });
  });

  it('treats a missing or unreadable due date as not submittable', () => {
    expect(checkSubmissionGuards({ ...good, dueAt: undefined }).ok).toBe(false);
    expect(checkSubmissionGuards({ ...good, dueAt: null }).ok).toBe(false);
    expect(checkSubmissionGuards({ ...good, dueAt: 'not a date' })).toMatchObject({ ok: false, code: 'DEADLINE_UNKNOWN' });
  });
});

describe('buildEvidences', () => {
  it('puts the response letter in the first item and maps tracking to tracking_info', () => {
    const out = buildEvidences(
      [
        { evidence_type: 'PROOF_OF_FULFILLMENT', notes: 'plan note', tracking_number: '9400111899223344556677', carrier: 'USPS' },
        { evidence_type: 'OTHER', notes: 'Packet attached.' },
      ],
      'The parcel was delivered on 2026-10-06.',
    );
    expect(out).toEqual([
      {
        evidence_type: 'PROOF_OF_FULFILLMENT',
        notes: 'The parcel was delivered on 2026-10-06.',
        evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: '9400111899223344556677' }] },
      },
      { evidence_type: 'OTHER', notes: 'Packet attached.' },
    ]);
  });

  it('falls back to a single OTHER item for an empty plan', () => {
    expect(buildEvidences([], 'Letter.')).toEqual([{ evidence_type: 'OTHER', notes: 'Letter.' }]);
  });

  it('keeps notes within PayPal’s 2000-character limit', () => {
    const [first] = buildEvidences([{ evidence_type: 'OTHER' }], 'x'.repeat(5000));
    expect(first.notes.length).toBeLessThanOrEqual(2000);
  });
});
