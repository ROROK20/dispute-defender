import { getDb, nowIso, parseJson } from "./db";
import { emitDone, emitStatus } from "./bus";
import { elapsedMs, truncate, valueFromCents } from "./format";
import { newDecisionId } from "./ids";
import { upsertDisputeFromPaypal } from "./sync";
import { checkSentences } from "./agent/citations";
import { allowedEvidenceTypes } from "./paypal/evidence-rules";
import { acceptClaim, getDispute, makeOffer, provideEvidence, sendMessage } from "./paypal/disputes";
import { renderEvidencePdf } from "./pdf/render";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE_CHARS = 2000;
export const MAX_MESSAGE_CHARS = 2000;

export class SubmitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    readonly debugId?: string | null,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SubmitError";
  }

  toBody(): { error: { code: string; message: string; debug_id?: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.debugId ? { debug_id: this.debugId } : {}),
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

interface DisputeRow {
  id: string;
  source: string;
  reason: string;
  status: string;
  amount_cents: number;
  currency: string;
  seller_response_due_at: string | null;
}

interface RunRow {
  id: string;
  dispute_id: string;
  status: string;
  clock_started_at: string;
  draft_json: string | null;
  evidence_plan_json: string | null;
}

interface Sentence {
  id: string;
  text: string;
  source_ids: string[];
}

interface Draft {
  sentences: Sentence[];
  removed: { id: string; text: string; reason: string }[];
}

interface EvidencePlanItem {
  evidence_type: string;
  notes?: string;
  tracking_number?: string;
  carrier?: string;
}

export interface PaypalEvidence {
  evidence_type: string;
  evidence_info?: { tracking_info: { carrier_name: string; tracking_number: string }[] };
  notes: string;
  documents?: { name: string }[];
}

interface CallRow {
  id: number;
  status_code: number | null;
  debug_id: string | null;
}

export interface PaypalOutcome {
  status_code: number | null;
  debug_id: string | null;
}

// ── Guards (pure) ─────────────────────────────────────────────────────

export interface GuardInput {
  source: string;
  paypalStatus: string | null | undefined;
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
  if (i.dueAt) {
    const due = Date.parse(i.dueAt);
    if (Number.isFinite(due) && i.now.getTime() >= due) {
      return { ok: false, code: "DEADLINE_PASSED", message: `The seller response deadline (${i.dueAt}) has passed.`, httpStatus: 409 };
    }
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
  if (i.pdfBytes > MAX_PDF_BYTES) {
    return { ok: false, code: "PDF_TOO_LARGE", message: `The evidence PDF is ${i.pdfBytes} bytes; the limit is ${MAX_PDF_BYTES}.`, httpStatus: 422 };
  }
  return { ok: true };
}

/** Maps the agent's evidence plan to PayPal's provide-evidence `evidences[]`. The PDF is attached to the first item. */
export function buildEvidences(plan: EvidencePlanItem[], letter: string, filename: string): PaypalEvidence[] {
  const items: EvidencePlanItem[] = plan.length > 0 ? plan : [{ evidence_type: "OTHER", notes: "" }];
  return items.map((item, idx) => {
    const notes = idx === 0 ? letter || item.notes || "" : item.notes || "";
    const evidence: PaypalEvidence = {
      evidence_type: item.evidence_type,
      notes: truncate(notes, MAX_NOTE_CHARS),
    };
    if (item.tracking_number) {
      evidence.evidence_info = {
        tracking_info: [{ carrier_name: item.carrier || "OTHER", tracking_number: item.tracking_number }],
      };
    }
    if (idx === 0) evidence.documents = [{ name: filename }];
    return evidence;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────

function loadDispute(disputeId: string): DisputeRow {
  const row = getDb()
    .prepare(`SELECT id, source, reason, status, amount_cents, currency, seller_response_due_at FROM disputes WHERE id = ?`)
    .get(disputeId) as DisputeRow | undefined;
  if (!row) throw new SubmitError("NOT_FOUND", `Dispute ${disputeId} not found.`, 404);
  if (row.source === "fixture") {
    throw new SubmitError("FIXTURE_READ_ONLY", "Fixture history disputes cannot be sent to PayPal.", 422);
  }
  return row;
}

function loadRun(runId: string, disputeId: string): RunRow {
  const row = getDb()
    .prepare(`SELECT id, dispute_id, status, clock_started_at, draft_json, evidence_plan_json FROM agent_runs WHERE id = ?`)
    .get(runId) as RunRow | undefined;
  if (!row || row.dispute_id !== disputeId) {
    throw new SubmitError("NOT_FOUND", `Run ${runId} not found for dispute ${disputeId}.`, 404);
  }
  return row;
}

function loadSourcesByKey(runId: string): Record<string, { source_key: string; kind: string; title: string; content: string; ref: string | null }> {
  const rows = getDb()
    .prepare(`SELECT source_key, kind, title, content, ref FROM sources WHERE run_id = ?`)
    .all(runId) as { source_key: string; kind: string; title: string; content: string; ref: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.source_key, r]));
}

function maxCallId(): number {
  const row = getDb().prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM paypal_calls`).get() as { id: number };
  return row.id;
}

function findCall(afterId: number, disputeId: string, pathSuffix: string): CallRow | null {
  const row = getDb()
    .prepare(
      `SELECT id, status_code, debug_id FROM paypal_calls
       WHERE id > ? AND path LIKE ? ORDER BY id DESC LIMIT 1`,
    )
    .get(afterId, `%/disputes/${disputeId}/${pathSuffix}%`) as CallRow | undefined;
  return row ?? null;
}

function errorInfo(err: unknown): { status: number | null; debugId: string | null; message: string } {
  const e = (err ?? {}) as Record<string, unknown>;
  const status =
    typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : null;
  const debugId =
    typeof e.debugId === "string" ? e.debugId : typeof e.debug_id === "string" ? e.debug_id : null;
  const message = err instanceof Error ? err.message : String(err);
  return { status, debugId, message };
}

async function fetchLiveDispute(disputeId: string): Promise<{ status?: string; seller_response_due_date?: string }> {
  try {
    const raw = await getDispute(disputeId);
    upsertDisputeFromPaypal(raw);
    return raw as { status?: string; seller_response_due_date?: string };
  } catch (err) {
    const info = errorInfo(err);
    throw new SubmitError("PAYPAL_ERROR", `Could not re-fetch dispute before submitting: ${info.message}`, 502, info.debugId);
  }
}

async function refreshAfterAction(disputeId: string): Promise<void> {
  try {
    upsertDisputeFromPaypal(await getDispute(disputeId));
  } catch (err) {
    console.warn(`[submit] post-action refresh of ${disputeId} failed:`, err instanceof Error ? err.message : err);
  }
}

function insertDecision(disputeId: string, runId: string | null, action: string, payload: unknown): string {
  const id = newDecisionId();
  getDb()
    .prepare(
      `INSERT INTO decisions (id, dispute_id, run_id, action, payload_json, result, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(id, disputeId, runId, action, JSON.stringify(payload), nowIso());
  return id;
}

function settleDecision(decisionId: string, result: "success" | "failed", call: CallRow | null): void {
  getDb()
    .prepare(`UPDATE decisions SET result = ?, paypal_call_id = ? WHERE id = ?`)
    .run(result, call?.id ?? null, decisionId);
}

/** Calls PayPal, links the logged paypal_calls row and settles the decision. */
async function performAction(
  decisionId: string,
  disputeId: string,
  pathSuffix: string,
  call: () => Promise<unknown>,
): Promise<PaypalOutcome> {
  const before = maxCallId();
  try {
    await call();
  } catch (err) {
    const info = errorInfo(err);
    const logged = findCall(before, disputeId, pathSuffix);
    settleDecision(decisionId, "failed", logged);
    throw new SubmitError(
      "PAYPAL_ERROR",
      `PayPal ${pathSuffix} failed${info.status ? ` (${info.status})` : ""}: ${info.message}`,
      502,
      info.debugId ?? logged?.debug_id ?? null,
    );
  }
  const logged = findCall(before, disputeId, pathSuffix);
  settleDecision(decisionId, "success", logged);
  return { status_code: logged?.status_code ?? 200, debug_id: logged?.debug_id ?? null };
}

// ── Approved actions ──────────────────────────────────────────────────

export interface SubmitEvidenceInput {
  disputeId: string;
  runId: string;
  editedSentences?: { id: string; text: string }[];
}

export interface SubmitEvidenceResult {
  decision_id: string;
  status: "submitted";
  paypal: PaypalOutcome;
  elapsed_ms: number | null;
}

/** Seller-approved provide-evidence. Never call from anywhere but an approval route. */
export async function submitEvidence(input: SubmitEvidenceInput): Promise<SubmitEvidenceResult> {
  const db = getDb();
  const dispute = loadDispute(input.disputeId);
  const run = loadRun(input.runId, dispute.id);
  if (run.status !== "draft_ready") {
    throw new SubmitError("INVALID_STATE", `Run is ${run.status}; only a draft_ready run can be approved.`, 409);
  }

  const draft = parseJson<Draft>(run.draft_json, { sentences: [], removed: [] });
  draft.removed = draft.removed ?? [];

  if (input.editedSentences && input.editedSentences.length > 0) {
    const edits = new Map(input.editedSentences.map((e) => [e.id, e.text.trim()]));
    const unknown = [...edits.keys()].filter((id) => !draft.sentences.some((s) => s.id === id));
    if (unknown.length > 0) {
      throw new SubmitError("CITATION_FAILED", `Unknown sentence id(s): ${unknown.join(", ")}.`, 422, null, { unknown });
    }
    const merged = draft.sentences.map((s) => (edits.has(s.id) ? { ...s, text: edits.get(s.id)! } : s));
    const edited = merged.filter((s) => edits.has(s.id));
    const check = checkSentences(edited, loadSourcesByKey(run.id));
    if (check.failed.length > 0) {
      throw new SubmitError(
        "CITATION_FAILED",
        `${check.failed.length} edited sentence(s) are not supported by their cited sources.`,
        422,
        null,
        { failed: check.failed },
      );
    }
    draft.sentences = merged.filter((s) => s.text.length > 0);
    db.prepare(`UPDATE agent_runs SET draft_json = ? WHERE id = ?`).run(JSON.stringify(draft), run.id);
  }

  if (draft.sentences.length === 0) {
    throw new SubmitError("EMPTY_DRAFT", "The draft has no supported sentences to submit.", 422);
  }

  const filename = `evidence-${dispute.id}.pdf`;
  const plan = parseJson<EvidencePlanItem[]>(run.evidence_plan_json, []);
  const letter = draft.sentences.map((s) => s.text).join(" ");
  const evidences = buildEvidences(plan, letter, filename);

  let pdf: Uint8Array;
  try {
    pdf = await renderEvidencePdf(run.id);
  } catch (err) {
    throw new SubmitError("PDF_FAILED", `Could not render the evidence PDF: ${(err as Error).message}`, 500);
  }

  const live = await fetchLiveDispute(dispute.id);
  const guard = checkSubmissionGuards({
    source: dispute.source,
    paypalStatus: live.status,
    dueAt: live.seller_response_due_date ?? dispute.seller_response_due_at,
    now: new Date(),
    reason: dispute.reason,
    evidenceTypes: evidences.map((e) => e.evidence_type),
    pdfBytes: pdf.byteLength,
  });
  if (!guard.ok) throw new SubmitError(guard.code, guard.message, guard.httpStatus);

  const decisionId = insertDecision(dispute.id, run.id, "submit_evidence", {
    evidences,
    filename,
    pdf_bytes: pdf.byteLength,
    sentence_count: draft.sentences.length,
    edited_sentence_ids: input.editedSentences?.map((e) => e.id) ?? [],
  });

  const paypal = await performAction(decisionId, dispute.id, "provide-evidence", () =>
    provideEvidence(dispute.id, { input: { evidences }, pdf, filename }, { runId: run.id }),
  );

  const finishedAt = nowIso();
  db.prepare(`UPDATE agent_runs SET status = 'submitted', finished_at = ? WHERE id = ?`).run(finishedAt, run.id);
  emitStatus(run.id, { status: "submitted", finished_at: finishedAt });
  emitDone(run.id);
  await refreshAfterAction(dispute.id);

  return {
    decision_id: decisionId,
    status: "submitted",
    paypal,
    elapsed_ms: elapsedMs(run.clock_started_at, finishedAt),
  };
}

export type OfferType = "REFUND" | "REFUND_WITH_RETURN" | "REFUND_WITH_REPLACEMENT";

export interface ConcedeInput {
  disputeId: string;
  runId?: string | null;
  action: "accept_claim" | "make_offer";
  note: string;
  offerAmountCents?: number;
  offerType?: OfferType;
}

export interface ConcedeResult {
  decision_id: string;
  paypal: PaypalOutcome;
}

const CONCEDABLE_STATUSES = new Set(["OPEN", "WAITING_FOR_SELLER_RESPONSE"]);

/** Seller-approved accept-claim or make-offer. */
export async function concede(input: ConcedeInput): Promise<ConcedeResult> {
  const db = getDb();
  const dispute = loadDispute(input.disputeId);
  const run = input.runId ? loadRun(input.runId, dispute.id) : null;
  if (run && !["draft_ready", "failed"].includes(run.status)) {
    throw new SubmitError("INVALID_STATE", `Run is ${run.status}; it cannot be conceded.`, 409);
  }

  const note = input.note.trim();
  if (!note) throw new SubmitError("VALIDATION", "A note to the buyer is required.", 400);
  if (note.length > MAX_NOTE_CHARS) {
    throw new SubmitError("VALIDATION", `The note is longer than ${MAX_NOTE_CHARS} characters.`, 400);
  }

  let offerCents = 0;
  if (input.action === "make_offer") {
    offerCents = Math.round(input.offerAmountCents ?? 0);
    if (offerCents <= 0 || offerCents > dispute.amount_cents) {
      throw new SubmitError("VALIDATION", "The offer must be greater than zero and no more than the disputed amount.", 400);
    }
  }

  const live = await fetchLiveDispute(dispute.id);
  if (!live.status || !CONCEDABLE_STATUSES.has(live.status)) {
    throw new SubmitError("INVALID_STATE", `PayPal status is ${live.status ?? "unknown"}; this action is not allowed now.`, 409);
  }

  let paypal: PaypalOutcome;
  let decisionId: string;
  if (input.action === "accept_claim") {
    const body = { note, accept_claim_type: "REFUND" as const };
    decisionId = insertDecision(dispute.id, run?.id ?? null, "accept_claim", body);
    paypal = await performAction(decisionId, dispute.id, "accept-claim", () =>
      acceptClaim(dispute.id, body, { runId: run?.id }),
    );
  } else {
    const body = {
      note,
      offer_amount: { currency_code: dispute.currency, value: valueFromCents(offerCents) },
      offer_type: input.offerType ?? "REFUND",
    };
    decisionId = insertDecision(dispute.id, run?.id ?? null, "make_offer", body);
    paypal = await performAction(decisionId, dispute.id, "make-offer", () =>
      makeOffer(dispute.id, body, { runId: run?.id }),
    );
  }

  if (run) {
    const finishedAt = nowIso();
    db.prepare(`UPDATE agent_runs SET status = 'conceded', finished_at = ? WHERE id = ?`).run(finishedAt, run.id);
    emitStatus(run.id, { status: "conceded", finished_at: finishedAt });
    emitDone(run.id);
  }
  await refreshAfterAction(dispute.id);

  return { decision_id: decisionId, paypal };
}

export interface MessageResult {
  decision_id: string;
  paypal: PaypalOutcome;
}

/** Seller-approved send-message to the buyer. */
export async function sendDisputeMessage(input: { disputeId: string; message: string }): Promise<MessageResult> {
  const dispute = loadDispute(input.disputeId);
  const message = input.message.trim();
  if (!message) throw new SubmitError("VALIDATION", "The message is empty.", 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new SubmitError("VALIDATION", `The message is longer than ${MAX_MESSAGE_CHARS} characters.`, 400);
  }

  const live = await fetchLiveDispute(dispute.id);
  if (live.status === "RESOLVED") {
    throw new SubmitError("INVALID_STATE", "This dispute is resolved; messages can no longer be sent.", 409);
  }

  const decisionId = insertDecision(dispute.id, null, "send_message", { message });
  const paypal = await performAction(decisionId, dispute.id, "send-message", () =>
    sendMessage(dispute.id, message, {}),
  );
  await refreshAfterAction(dispute.id);
  return { decision_id: decisionId, paypal };
}