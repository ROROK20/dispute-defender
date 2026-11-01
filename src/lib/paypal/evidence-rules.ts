/**
 * Single typed map from PayPal dispute reason code to the evidence_type values
 * the submission service is allowed to send. Confirmed against the sandbox in
 * Phase 1; this file is the only place to correct them.
 */

export const REASON_CODES = [
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'UNAUTHORISED',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT',
  'PROOF_OF_DELIVERY_SIGNATURE',
  'ITEM_DESCRIPTION',
  'RETURN_POLICY',
  'OTHER',
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_RULES: Readonly<Record<string, readonly EvidenceType[]>> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_DELIVERY_SIGNATURE', 'OTHER'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['ITEM_DESCRIPTION', 'RETURN_POLICY', 'PROOF_OF_FULFILLMENT', 'OTHER'],
  UNAUTHORISED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_DELIVERY_SIGNATURE', 'OTHER'],
};

const DEFAULT_ALLOWED: readonly EvidenceType[] = ['OTHER'];

/** Evidence types that PayPal expects to carry `evidence_info.tracking_info`. */
export const TRACKING_REQUIRED_TYPES: readonly EvidenceType[] = ['PROOF_OF_FULFILLMENT'];

export function normalizeReason(reason: string | null | undefined): string {
  const r = (reason ?? '').trim().toUpperCase();
  // PayPal spells it UNAUTHORISED; accept the US spelling defensively.
  if (r === 'UNAUTHORIZED') return 'UNAUTHORISED';
  return r;
}

export function isReasonCode(value: string): value is ReasonCode {
  return (REASON_CODES as readonly string[]).includes(value);
}

export function isEvidenceType(value: string): value is EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(value);
}

export function allowedEvidenceTypes(reason: string | null | undefined): readonly EvidenceType[] {
  return EVIDENCE_RULES[normalizeReason(reason)] ?? DEFAULT_ALLOWED;
}

export function isEvidenceAllowed(reason: string | null | undefined, evidenceType: string): boolean {
  return allowedEvidenceTypes(reason).includes(evidenceType as EvidenceType);
}

export function requiresTrackingInfo(evidenceType: string): boolean {
  return TRACKING_REQUIRED_TYPES.includes(evidenceType as EvidenceType);
}

export interface EvidencePlanItemLike {
  evidence_type: string;
  tracking_number?: string | null;
  evidence_info?: { tracking_info?: { carrier_name?: string; tracking_number?: string }[] } | null;
}

export interface EvidenceValidation {
  ok: boolean;
  allowed: readonly EvidenceType[];
  rejected: { evidence_type: string; reason: 'NOT_ALLOWED_FOR_REASON' | 'MISSING_TRACKING_INFO' | 'UNKNOWN_TYPE' }[];
}

/** Validates a full evidence plan for a reason code. Empty plans are rejected. */
export function validateEvidencePlan(
  reason: string | null | undefined,
  evidences: readonly EvidencePlanItemLike[],
): EvidenceValidation {
  const allowed = allowedEvidenceTypes(reason);
  const rejected: EvidenceValidation['rejected'] = [];
  for (const ev of evidences) {
    if (!isEvidenceType(ev.evidence_type)) {
      rejected.push({ evidence_type: ev.evidence_type, reason: 'UNKNOWN_TYPE' });
      continue;
    }
    if (!allowed.includes(ev.evidence_type)) {
      rejected.push({ evidence_type: ev.evidence_type, reason: 'NOT_ALLOWED_FOR_REASON' });
      continue;
    }
    if (requiresTrackingInfo(ev.evidence_type)) {
      const hasInfo =
        Boolean(ev.tracking_number) ||
        Boolean(ev.evidence_info?.tracking_info?.some((t) => Boolean(t.tracking_number)));
      if (!hasInfo) rejected.push({ evidence_type: ev.evidence_type, reason: 'MISSING_TRACKING_INFO' });
    }
  }
  return { ok: evidences.length > 0 && rejected.length === 0, allowed, rejected };
}