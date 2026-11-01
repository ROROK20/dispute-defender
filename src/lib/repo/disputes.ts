import { getDb } from '../db';

export type DisputeSource = 'paypal_sandbox' | 'fixture';
export type Recommendation = 'FIGHT' | 'ACCEPT_CLAIM' | 'MAKE_OFFER';

export interface DisputeRecord {
  id: string;
  source: DisputeSource;
  order_id: string | null;
  capture_id: string | null;
  sku: string | null;
  reason: string;
  stage: string | null;
  status: string;
  outcome: string | null;
  amount_cents: number;
  currency: string;
  seller_response_due_at: string | null;
  pp_created_at: string | null;
  pp_updated_at: string | null;
  last_synced_at: string;
  strength_score: number | null;
  recommendation: Recommendation | null;
  raw_json: string;
}

export interface Dispute extends DisputeRecord {
  raw: Record<string, unknown> | null;
}

export interface DisputeInput {
  id: string;
  source: DisputeSource;
  order_id?: string | null;
  capture_id?: string | null;
  sku?: string | null;
  reason: string;
  stage?: string | null;
  status: string;
  outcome?: string | null;
  amount_cents: number;
  currency: string;
  seller_response_due_at?: string | null;
  pp_created_at?: string | null;
  pp_updated_at?: string | null;
  raw: unknown;
}

export interface LatestRunSummary {
  id: string;
  status: string;
  draft_ready_ms: number | null;
  submitted_ms: number | null;
}

export interface DisputeRow {
  id: string;
  source: DisputeSource;
  reason: string;
  status: string;
  stage: string | null;
  amount_cents: number;
  currency: string;
  sku: string | null;
  sku_name: string | null;
  buyer_name: string | null;
  seller_response_due_at: string | null;
  strength_score: number | null;
  recommendation: Recommendation | null;
  latest_run: LatestRunSummary | null;
}

export interface DisputeFilters {
  status?: string;
  reason?: string;
  sku?: string;
  source?: DisputeSource;
}

function parseRaw(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function hydrate(row: DisputeRecord | undefined): Dispute | null {
  if (!row) return null;
  return { ...row, raw: parseRaw(row.raw_json) };
}

function msBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

/** Buyer name from the PayPal dispute body when no order row carries it. */
function buyerNameFromRaw(rawJson: string): string | null {
  const raw = parseRaw(rawJson);
  if (!raw) return null;
  const txs = raw['disputed_transactions'];
  if (Array.isArray(txs) && txs.length > 0) {
    const buyer = (txs[0] as Record<string, unknown>)['buyer'] as Record<string, unknown> | undefined;
    const name = buyer?.['name'];
    if (typeof name === 'string' && name.trim()) return name;
  }
  return null;
}

export function upsertDispute(input: DisputeInput): Dispute {
  if (!input.id) throw new Error('Dispute id is required');
  if (!Number.isInteger(input.amount_cents)) throw new Error(`Dispute ${input.id}: amount_cents must be an integer`);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO disputes (id, source, order_id, capture_id, sku, reason, stage, status, outcome, amount_cents,
                             currency, seller_response_due_at, pp_created_at, pp_updated_at, last_synced_at, raw_json)
       VALUES (@id, @source, @order_id, @capture_id, @sku, @reason, @stage, @status, @outcome, @amount_cents,
               @currency, @seller_response_due_at, @pp_created_at, @pp_updated_at, @last_synced_at, @raw_json)
       ON CONFLICT(id) DO UPDATE SET
         order_id               = COALESCE(excluded.order_id, disputes.order_id),
         capture_id             = COALESCE(excluded.capture_id, disputes.capture_id),
         sku                    = COALESCE(excluded.sku, disputes.sku),
         reason                 = excluded.reason,
         stage                  = excluded.stage,
         status                 = excluded.status,
         outcome                = COALESCE(excluded.outcome, disputes.outcome),
         amount_cents           = excluded.amount_cents,
         currency               = excluded.currency,
         seller_response_due_at = excluded.seller_response_due_at,
         pp_created_at          = COALESCE(excluded.pp_created_at, disputes.pp_created_at),
         pp_updated_at          = excluded.pp_updated_at,
         last_synced_at         = excluded.last_synced_at,
         raw_json               = excluded.raw_json`,
    )
    .run({
      id: input.id,
      source: input.source,
      order_id: input.order_id ?? null,
      capture_id: input.capture_id ?? null,
      sku: input.sku ?? null,
      reason: input.reason,
      stage: input.stage ?? null,
      status: input.status,
      outcome: input.outcome ?? null,
      amount_cents: input.amount_cents,
      currency: input.currency,
      seller_response_due_at: input.seller_response_due_at ?? null,
      pp_created_at: input.pp_created_at ?? null,
      pp_updated_at: input.pp_updated_at ?? null,
      last_synced_at: now,
      raw_json: JSON.stringify(input.raw ?? {}),
    });
  const d = getDispute(input.id);
  if (!d) throw new Error(`Dispute ${input.id} was not stored`);
  return d;
}

export function getDispute(id: string): Dispute | null {
  return hydrate(getDb().prepare(`SELECT * FROM disputes WHERE id = ?`).get(id) as DisputeRecord | undefined);
}

export function disputeExists(id: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM disputes WHERE id = ?`).get(id);
}

interface ListJoinRow extends DisputeRecord {
  sku_name: string | null;
  order_buyer_name: string | null;
  run_id: string | null;
  run_status: string | null;
  run_clock_started_at: string | null;
  run_draft_ready_at: string | null;
  run_finished_at: string | null;
}

export function listDisputes(filters: DisputeFilters = {}): DisputeRow[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filters.status) {
    where.push('d.status = @status');
    params.status = filters.status;
  }
  if (filters.reason) {
    where.push('d.reason = @reason');
    params.reason = filters.reason;
  }
  if (filters.sku) {
    where.push('d.sku = @sku');
    params.sku = filters.sku;
  }
  if (filters.source) {
    where.push('d.source = @source');
    params.source = filters.source;
  }
  const sql = `
    SELECT d.*, s.name AS sku_name, o.buyer_name AS order_buyer_name,
           r.id AS run_id, r.status AS run_status, r.clock_started_at AS run_clock_started_at,
           r.draft_ready_at AS run_draft_ready_at, r.finished_at AS run_finished_at
    FROM disputes d
    LEFT JOIN skus s ON s.sku = d.sku
    LEFT JOIN orders o ON o.id = d.order_id
    LEFT JOIN agent_runs r ON r.id = (
      SELECT ar.id FROM agent_runs ar WHERE ar.dispute_id = d.id
      ORDER BY ar.clock_started_at DESC, ar.rowid DESC LIMIT 1
    )
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE WHEN d.seller_response_due_at IS NULL THEN 1 ELSE 0 END,
             d.seller_response_due_at ASC, d.pp_created_at DESC`;
  const rows = getDb().prepare(sql).all(params) as ListJoinRow[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    reason: r.reason,
    status: r.status,
    stage: r.stage,
    amount_cents: r.amount_cents,
    currency: r.currency,
    sku: r.sku,
    sku_name: r.sku_name,
    buyer_name: r.order_buyer_name ?? buyerNameFromRaw(r.raw_json),
    seller_response_due_at: r.seller_response_due_at,
    strength_score: r.strength_score,
    recommendation: r.recommendation,
    latest_run: r.run_id
      ? {
          id: r.run_id,
          status: r.run_status ?? 'queued',
          draft_ready_ms: msBetween(r.run_clock_started_at, r.run_draft_ready_at),
          submitted_ms:
            r.run_status === 'submitted' || r.run_status === 'conceded'
              ? msBetween(r.run_clock_started_at, r.run_finished_at)
              : null,
        }
      : null,
  }));
}

export function listAllDisputes(): Dispute[] {
  const rows = getDb().prepare(`SELECT * FROM disputes ORDER BY pp_created_at ASC`).all() as DisputeRecord[];
  return rows.map((r) => hydrate(r)!);
}

/** Real staged sandbox disputes waiting for the seller with no run yet: the demo-trigger pool. */
export function listDemoPool(): Dispute[] {
  const rows = getDb()
    .prepare(
      `SELECT d.* FROM disputes d
       WHERE d.source = 'paypal_sandbox' AND d.status = 'WAITING_FOR_SELLER_RESPONSE'
         AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispute_id = d.id)
       ORDER BY COALESCE(d.pp_created_at, d.last_synced_at) ASC`,
    )
    .all() as DisputeRecord[];
  return rows.map((r) => hydrate(r)!);
}

/** Disputes waiting for the seller that have never had a run (used by the poller). */
export function listWaitingWithoutRun(): Dispute[] {
  return listDemoPool();
}

export function updateDisputeStatus(
  id: string,
  patch: { status: string; outcome?: string | null; stage?: string | null },
): void {
  const res = getDb()
    .prepare(
      `UPDATE disputes SET status = @status,
         outcome = COALESCE(@outcome, outcome),
         stage = COALESCE(@stage, stage),
         last_synced_at = @now
       WHERE id = @id`,
    )
    .run({
      id,
      status: patch.status,
      outcome: patch.outcome ?? null,
      stage: patch.stage ?? null,
      now: new Date().toISOString(),
    });
  if (res.changes === 0) throw new Error(`Dispute ${id} not found`);
}

export function setDisputeAssessment(
  id: string,
  assessment: { strength_score: number | null; recommendation: Recommendation | null },
): void {
  getDb()
    .prepare(`UPDATE disputes SET strength_score = @strength_score, recommendation = @recommendation WHERE id = @id`)
    .run({ id, strength_score: assessment.strength_score, recommendation: assessment.recommendation });
}

/** Most recent PayPal update_time stored for a sandbox dispute; poller uses it as `update_time_after`. */
export function getLatestSandboxUpdateTime(): string | null {
  const row = getDb()
    .prepare(`SELECT MAX(pp_updated_at) AS t FROM disputes WHERE source = 'paypal_sandbox'`)
    .get() as { t: string | null };
  return row.t ?? null;
}

/** Disputes with the same (sku, reason) opened in the `days` before `beforeIso`, excluding one id. */
export function countPriorOnSku(
  sku: string,
  reason: string,
  beforeIso: string,
  excludeId: string,
  days = 90,
): { count: number; ids: string[] } {
  const before = Date.parse(beforeIso);
  if (Number.isNaN(before)) return { count: 0, ids: [] };
  const after = new Date(before - days * 86_400_000).toISOString();
  const rows = getDb()
    .prepare(
      `SELECT id FROM disputes
       WHERE sku = @sku AND reason = @reason AND id != @exclude
         AND pp_created_at IS NOT NULL AND pp_created_at < @before AND pp_created_at >= @after`,
    )
    .all({ sku, reason, exclude: excludeId, before: new Date(before).toISOString(), after }) as { id: string }[];
  return { count: rows.length, ids: rows.map((r) => r.id) };
}

export function countDisputes(): { total: number; fixture: number; sandbox: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN source = 'fixture' THEN 1 ELSE 0 END) AS fixture,
              SUM(CASE WHEN source = 'paypal_sandbox' THEN 1 ELSE 0 END) AS sandbox
       FROM disputes`,
    )
    .get() as { total: number; fixture: number | null; sandbox: number | null };
  return { total: row.total, fixture: row.fixture ?? 0, sandbox: row.sandbox ?? 0 };
}