import { getDb } from '../db';
import { nanoid } from 'nanoid';

export type DecisionAction = 'submit_evidence' | 'accept_claim' | 'make_offer' | 'send_message';
export type DecisionResult = 'pending' | 'success' | 'failed';

export interface DecisionRow {
  id: string;
  dispute_id: string;
  run_id: string | null;
  action: DecisionAction;
  payload_json: string;
  result: DecisionResult;
  paypal_call_id: number | null;
  created_at: string;
}

export interface Decision extends DecisionRow {
  payload: unknown | null;
}

function hydrate(row: DecisionRow | undefined): Decision | null {
  if (!row) return null;
  let payload: unknown | null = null;
  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch {
    payload = null;
  }
  return { ...row, payload };
}

export function createDecision(input: {
  dispute_id: string;
  run_id?: string | null;
  action: DecisionAction;
  payload: unknown;
}): Decision {
  const id = `dec_${nanoid(12)}`;
  getDb()
    .prepare(
      `INSERT INTO decisions (id, dispute_id, run_id, action, payload_json, result, created_at)
       VALUES (@id, @dispute_id, @run_id, @action, @payload_json, 'pending', @created_at)`,
    )
    .run({
      id,
      dispute_id: input.dispute_id,
      run_id: input.run_id ?? null,
      action: input.action,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: new Date().toISOString(),
    });
  return getDecision(id)!;
}

export function completeDecision(
  id: string,
  result: Exclude<DecisionResult, 'pending'>,
  paypalCallId: number | null,
): Decision {
  const res = getDb()
    .prepare(`UPDATE decisions SET result = @result, paypal_call_id = @paypal_call_id WHERE id = @id`)
    .run({ id, result, paypal_call_id: paypalCallId });
  if (res.changes === 0) throw new Error(`Decision ${id} not found`);
  return getDecision(id)!;
}

export function getDecision(id: string): Decision | null {
  return hydrate(getDb().prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as DecisionRow | undefined);
}

export function listDecisions(disputeId: string): Decision[] {
  const rows = getDb()
    .prepare(`SELECT * FROM decisions WHERE dispute_id = ? ORDER BY created_at ASC`)
    .all(disputeId) as DecisionRow[];
  return rows.map((r) => hydrate(r)!);
}

export function hasSuccessfulDecision(disputeId: string, actions?: DecisionAction[]): boolean {
  const list = actions && actions.length ? actions : ['submit_evidence', 'accept_claim', 'make_offer'];
  const placeholders = list.map(() => '?').join(',');
  return !!getDb()
    .prepare(
      `SELECT 1 FROM decisions WHERE dispute_id = ? AND result = 'success' AND action IN (${placeholders}) LIMIT 1`,
    )
    .get(disputeId, ...list);
}