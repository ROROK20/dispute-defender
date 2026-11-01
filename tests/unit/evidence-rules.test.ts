import { describe, it, expect } from 'vitest';
import { allowedEvidenceTypes, isEvidenceAllowed } from '../../src/lib/paypal/evidence-rules';

describe('evidence rules', () => {
  it('maps INR to fulfillment, signature and other', () => {
    expect([...allowedEvidenceTypes('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')].sort()).toEqual(
      ['OTHER', 'PROOF_OF_DELIVERY_SIGNATURE', 'PROOF_OF_FULFILLMENT'].sort(),
    );
  });

  it('maps SNAD to description, return policy, fulfillment and other', () => {
    expect([...allowedEvidenceTypes('MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED')].sort()).toEqual(
      ['ITEM_DESCRIPTION', 'OTHER', 'PROOF_OF_FULFILLMENT', 'RETURN_POLICY'].sort(),
    );
  });

  it('maps UNAUTHORISED to fulfillment, signature and other', () => {
    expect([...allowedEvidenceTypes('UNAUTHORISED')].sort()).toEqual(
      ['OTHER', 'PROOF_OF_DELIVERY_SIGNATURE', 'PROOF_OF_FULFILLMENT'].sort(),
    );
  });

  it('falls back to OTHER only for unknown reasons', () => {
    expect([...allowedEvidenceTypes('CREDIT_NOT_PROCESSED')]).toEqual(['OTHER']);
    expect([...allowedEvidenceTypes('SOMETHING_NEW')]).toEqual(['OTHER']);
  });

  it('rejects evidence types outside the map', () => {
    expect(isEvidenceAllowed('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'PROOF_OF_FULFILLMENT')).toBe(true);
    expect(isEvidenceAllowed('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'RETURN_POLICY')).toBe(false);
    expect(isEvidenceAllowed('MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'ITEM_DESCRIPTION')).toBe(false);
    expect(isEvidenceAllowed('UNAUTHORISED', 'RETURN_POLICY')).toBe(false);
    expect(isEvidenceAllowed('CREDIT_NOT_PROCESSED', 'PROOF_OF_FULFILLMENT')).toBe(false);
    expect(isEvidenceAllowed('CREDIT_NOT_PROCESSED', 'OTHER')).toBe(true);
  });

  it('always allows OTHER', () => {
    for (const r of [
      'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      'UNAUTHORISED',
      'DUPLICATE_TRANSACTION',
    ]) {
      expect(isEvidenceAllowed(r, 'OTHER')).toBe(true);
    }
  });
});