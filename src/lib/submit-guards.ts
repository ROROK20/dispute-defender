import { truncate } from "./format";
import { allowedEvidenceTypes } from "./paypal/evidence-rules";
import type { TrackingInfo } from "./paypal/multipart";

/**
 * Pure pre-submission checks for the submission service (ARCHITECTURE.md C10).
 * Kept free of DB, PDF and PayPal imports so the guards can be unit-tested in
 * isolation; src/lib/submit.ts re-exports everything here.
 */

/** PayPal's per-file evidence limit. The PDF must be strictly under it. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE_CHARS = 2000;

export interface GuardInput {
  source: string;
  /** Status from the dispute as just re-fetched from PayPal. */
  paypalStatus: string | null | undefined;
  /** seller_response_due_date from PayPal (or the stored copy). */
  dueAt: string | null | undefined;
  now: Date;
  reason: string;
  evidenceTypes: string[];
  pdfBytes: number;
}

export type GuardResult =
  | { ok: true }
  | { ok: false; code: string; message: string; httpStatus: number };

export function checkSubmissionGuards(i: GuardInput): GuardResult {
  if (i.source === "fixture") {
    return { ok: false, code: "FIXTURE_READ_ONLY", message: "Fixture history disputes cannot be sent to PayPal.", httpStatus: 422 };
  }
  if (i.paypalStatus !== "WAITING_FOR_SELLER_RESPONSE") {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: `PayPal status is ${i.paypalStatus ?? "unknown"}; evidence can only be provided while WAITING_FOR_SELLER_RESPONSE.`,
      httpStatus: 409,
    };
  }
  // The rule is `now < seller_response_due_date`. Without a readable due date that cannot be shown, so refuse.
  const due = i.dueAt ? Date.parse(i.dueAt) : Number.NaN;
  if (!Number.isFinite(due)) {
    return {
      ok: false,
      code: "DEADLINE_UNKNOWN",
      message: "PayPal did not return a seller response due date, so the deadline cannot be confirmed.",
      httpStatus: 409,
    };
  }
  if (i.now.getTime() >= due) {
    return { ok: false, code: "DEADLINE_PASSED", message: `The seller response deadline (${i.dueAt}) has passed.`, httpStatus: 409 };
  }
  if (i.evidenceTypes.length === 0) {
    return { ok: false, code: "NO_EVIDENCE", message: "The evidence plan is empty.", httpStatus: 422 };
  }
  const allowed = new Set<string>(allowedEvidenceTypes(i.reason));
  const bad = i.evidenceTypes.filter((t) => !allowed.has(t));
  if (bad.length > 0) {
    return {
      ok: false,
      code: "EVIDENCE_TYPE_NOT_ALLOWED",
      message: `Evidence type(s) ${bad.join(", ")} are not allowed for ${i.reason}. Allowed: ${[...allowed].join(", ")}.`,
      httpStatus: 422,
    };
  }
  if (i.pdfBytes <= 0) {
    return { ok: false, code: "PDF_EMPTY", message: "The evidence PDF is empty.", httpStatus: 422 };
  }
  if (i.pdfBytes >= MAX_PDF_BYTES) {
    return {
      ok: false,
      code: "PDF_TOO_LARGE",
      message: `The evidence PDF is ${i.pdfBytes} bytes; it must be under ${MAX_PDF_BYTES}.`,
      httpStatus: 422,
    };
  }
  return { ok: true };
}

/** One item of the agent's evidence plan (agent_runs.evidence_plan_json). */
export interface EvidencePlanItem {
  evidence_type: string;
  notes?: string;
  tracking_number?: string;
  carrier?: string;
}

/**
 * A provide-evidence item before the guards have checked its type. Once
 * checkSubmissionGuards passes, every evidence_type is a known EvidenceType.
 * The PDF document reference is added by paypal/multipart.ts.
 */
export interface PlannedEvidence {
  evidence_type: string;
  notes: string;
  evidence_info?: { tracking_info: TrackingInfo[] };
}

/**
 * Maps the evidence plan to PayPal's provide-evidence `evidences[]`.
 * The response letter goes in the first item's notes; an empty plan becomes one OTHER item.
 */
export function buildEvidences(plan: EvidencePlanItem[], letter: string): PlannedEvidence[] {
  const items: EvidencePlanItem[] = plan.length > 0 ? plan : [{ evidence_type: "OTHER", notes: "" }];
  return items.map((item, idx) => {
    const notes = idx === 0 ? letter || item.notes || "" : item.notes || "";
    const evidence: PlannedEvidence = {
      evidence_type: item.evidence_type,
      notes: truncate(notes, MAX_NOTE_CHARS),
    };
    if (item.tracking_number) {
      evidence.evidence_info = {
        tracking_info: [{ carrier_name: item.carrier || "OTHER", tracking_number: item.tracking_number }],
      };
    }
    return evidence;
  });
}
