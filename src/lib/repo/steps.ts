import { getDb } from '../db';

export type StepKind = 'info' | 'tool_call' | 'tool_result' | 'check' | 'decision' | 'review' | 'error';

export interface StepRow {
  id: number;
  run_id: string;
  seq: number;
  kind: StepKind;
  label: string;
  payload_json: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface Step extends StepRow {
  payload: unknown | null;
}

export interface StepInput {
  kind: StepKind;
  label: string;
  payload?: unknown;
  duration_ms?: number | null;
}

/** Shape sent over SSE as the `step` event. */
export interface StepEvent {
  seq: number;
  kind: StepKind;
  label: string;
  payload: unknown | null;
  duration_ms: number | null;
  created_at: string;
}

function hydrate(row: StepRow): Step {
  let payload: unknown | null = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json) as unknown;
    } catch {
      payload = null;
    }
  }
  return { ...row, payload };
}

export function toStepEvent(step: Step): StepEvent {
  return {
    seq: step.seq,
    kind: step.kind,
    label: step.label,
    payload: step.payload,
    duration_ms: step.duration_ms,
    created_at: step.created_at,
  };
}

/** Appends a step with the next seq for the run, atomically. */
export function appendStep(runId: string, input: StepInput): Step {
  const db = getDb();
  const tx = db.transaction((): Step => {
    const { next } = db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_steps WHERE run_id = ?`)
      .get(runId) as { next: number };
    const createdAt = new Date().toISOString();
    let payloadJson: string | null = null;
    if (input.payload !== undefined) {
      try {
        payloadJson = JSON.stringify(input.payload);
      } catch {
        payloadJson = JSON.stringify({ unserializable: String(input.payload) });
      }
    }
    const res = db
      .prepare(
        `INSERT INTO agent_steps (run_id, seq, kind, label, payload_json, duration_ms, created_at)
         VALUES (@run_id, @seq, @kind, @label, @payload_json, @duration_ms, @created_at)`,
      )
      .run({
        run_id: runId,
        seq: next,
        kind: input.kind,
        label: input.label.slice(0, 500),
        payload_json: payloadJson,
        duration_ms: input.duration_ms == null ? null : Math.round(input.duration_ms),
        created_at: createdAt,
      });
    const row = db.prepare(`SELECT * FROM agent_steps WHERE id = ?`).get(res.lastInsertRowid) as StepRow;
    return hydrate(row);
  });
  return tx();
}

export function listSteps(runId: string): Step[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_steps WHERE run_id = ? ORDER BY seq ASC`)
    .all(runId) as StepRow[];
  return rows.map(hydrate);
}

export function listStepsAfter(runId: string, afterSeq: number): Step[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_steps WHERE run_id = ? AND seq > ? ORDER BY seq ASC`)
    .all(runId, afterSeq) as StepRow[];
  return rows.map(hydrate);
}