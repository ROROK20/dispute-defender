import { describe, it, expect } from 'vitest';
import { checkSubmitGuards } from '../../src/lib/submit';

const NOW = new Date('2026-10-28T12:00:00Z');
const MB = 1024 * 1024;

const dispute = {
  dispute_id: 'PP-D-27803',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  seller_response_due_date: '2026-11-07T23:59:59Z',
};

const good = {
  dispute,
  source: 'paypal_sandbox' as const,
  evidenceTypes: ['PROOF_OF_FULFILLMENT'],
  pdfBytes: 300 * 1024,
  now: NOW,
};

describe('checkSubmitGuards', () => {
  it('passes a valid submission', () => {
    expect(checkSubmitGuards(good)).toEqual({ ok: true });
  });

  it('rejects fixture disputes with FIXTURE_READ_ONLY', () => {
    const r = checkSubmitGuards({ ...good, source: 'fixture' as const });
    expect(r).toMatchObject({ ok: false, code: 'FIXTURE_READ_ONLY' });
  });

  it('rejects disputes not waiting for seller response', () => {
    for (const status of ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'WAITING_FOR_BUYER_RESPONSE']) {
      const r = checkSubmitGuards({ ...good, dispute: { ...dispute, status } });
      expect(r).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    }
  });

  it('rejects submissions after the seller response deadline', () => {
    const r = checkSubmitGuards({ ...good, now: new Date('2026-11-08T00:00:00Z') });
    expect(r).toMatchObject({ ok: false, code: 'DEADLINE_PASSED' });
  });

  it('rejects at exactly the deadline', () => {
    const r = checkSubmitGuards({ ...good, now: new Date(dispute.seller_response_due_date) });
    expect(r.ok).toBe(false);
  });

  it('rejects evidence types not allowed for the reason code', () => {
    const r = checkSubmitGuards({ ...good, evidenceTypes: ['PROOF_OF_FULFILLMENT', 'RETURN_POLICY'] });
    expect(r).toMatchObject({ ok: false, code: 'EVIDENCE_TYPE_NOT_ALLOWED' });
  });

  it('rejects an empty evidence list', () => {
    const r = checkSubmitGuards({ ...good, evidenceTypes: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects PDFs of 10 MB or more', () => {
    expect(checkSubmitGuards({ ...good, pdfBytes: 10 * MB })).toMatchObject({ ok: false, code: 'PDF_TOO_LARGE' });
    expect(checkSubmitGuards({ ...good, pdfBytes: 10 * MB - 1 })).toEqual({ ok: true });
  });

  it('treats a missing due date as not submittable', () => {
    const r = checkSubmitGuards({ ...good, dispute: { ...dispute, seller_response_due_date: undefined } });
    expect(r.ok).toBe(false);
  });
});