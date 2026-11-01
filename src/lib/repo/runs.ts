import { getDb } from '../db';
import { nanoid } from 'nanoid';

export type RunStatus = 'queued' | 'running' | 'draft_ready' | 'failed' | 'submitted' | 'conceded';

export interface AgentRunRow {
  id: string;
  dispute_id: string;
  trigger_event_id: string | null;
  status: RunStatus;
  clock_started_at: string;
  started_at: string | null;
  draft_ready_at: string | null;
  finished_at: string | null;
  model_agent: string;
  model_review: string | null;
  classification_json: string | null;
  strength_json: string | null;
  ev_json: string | null;
  recommendation: string | null;
  draft_json: string | null;
  evidence_plan_json: string | null;
  review_applied: number;
  citation_check_json: string | null;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}

export interface AgentRun extends AgentRunRow {
  classification: unknown | null;
  strength: unknown | null;
  ev: unknown | null;
  draft: unknown | null;
  evidence_plan: unknown | null;
  citation_check: unknown | null;
}

export interface CreateRunInput {
  dispute_id: string;
  trigger_event_id?: string | null;
  clock_started_at: string;
  model_agent: string;
  model_review?: string | null;
  id?: string;
}

export interface RunPatch {
  status?: RunStatus;
  started_at?: string | null;
  draft_ready_at?: string | null;
  finished_at?: string | null;
  model_review?: string | null;
  classification?: unknown;
  strength?: unknown;
  ev?: unknown;
  recommendation?: string | null;
  draft?: unknown;
  evidence_plan?: unknown;
  review_applied?: boolean;
  citation_check?: unknown;
  error?: string | null;
}

export class RunActiveError extends Error {
  readonly code = 'RUN_ACTIVE';
  constructor(public readonly disputeId: string) {
    super(`Dispute ${disputeId} already has a queued or running agent run`);
    this.name = 'RunActiveError';
  }
}

function parse(text: string | null): unknown | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function hydrate(row: AgentRunRow | undefined): AgentRun | null {
  if (!row) return null;
  return {
    ...row,
    classification: parse(row.classification_json),
    strength: parse(row.strength_json),
    ev: parse(row.ev_json),
    draft: parse(row.draft_json),
    evidence_plan: parse(row.evidence_plan_json),
    citation_check: parse(row.citation_check_json),
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

/** Creates a queued run. Throws RunActiveError if the partial unique index rejects it. */
export function createRun(input: CreateRunInput): AgentRun {
  const id = input.id ?? `run_${nanoid(12)}`;
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_runs (id, dispute_id, trigger_event_id, status, clock_started_at, model_agent, model_review)
         VALUES (@id, @dispute_id, @trigger_event_id, 'queued', @clock_started_at, @model_agent, @model_review)`,
      )
      .run({
        id,
        dispute_id: input.dispute_id,
        trigger_event_id: input.trigger_event_id ?? null,
        clock_started_at: input.clock_started_at,
        model_agent: input.model_agent,
        model_review: input.model_review ?? null,
      });
  } catch (err) {
    if (isUniqueViolation(err)) throw new RunActiveError(input.dispute_id);
    throw err;
  }
  return getRun(id)!;
}

export function getRun(id: string): AgentRun | null {
  return hydrate(getDb().prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as AgentRunRow | undefined);
}

export function getLatestRunForDispute(disputeId: string): AgentRun | null {
  return hydrate(
    getDb()
      .prepare(
        `SELECT * FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(disputeId) as AgentRunRow | undefined,
  );
}

export function getActiveRun(disputeId: string): AgentRun | null {
  return hydrate(
    getDb()
      .prepare(`SELECT * FROM agent_runs WHERE dispute_id = ? AND status IN ('queued','running') LIMIT 1`)
      .get(disputeId) as AgentRunRow | undefined,
  );
}

export function listRunsForDispute(disputeId: string): AgentRun[] {
  const rows = getDb()
    .prepare(`SELECT * FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC, rowid DESC`)
    .all(disputeId) as AgentRunRow[];
  return rows.map((r) => hydrate(r)!);
}

export function hasAnyRun(disputeId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM agent_runs WHERE dispute_id = ? LIMIT 1`).get(disputeId);
}

const JSON_FIELDS: Record<string, keyof AgentRunRow> = {
  classification: 'classification_json',
  strength: 'strength_json',
  ev: 'ev_json',
  draft: 'draft_json',
  evidence_plan: 'evidence_plan_json',
  citation_check: 'citation_check_json',
};

const PLAIN_FIELDS = new Set([
  'status',
  'started_at',
  'draft_ready_at',
  'finished_at',
  'model_review',
  'recommendation',
  'error',
]);

export function updateRun(id: string, patch: RunPatch): AgentRun {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key in JSON_FIELDS) {
      const col = JSON_FIELDS[key];
      sets.push(`${col} = @${col}`);
      params[col] = value === null ? null : JSON.stringify(value);
    } else if (key === 'review_applied') {
      sets.push('review_applied = @review_applied');
      params.review_applied = value ? 1 : 0;
    } else if (PLAIN_FIELDS.has(key)) {
      sets.push(`${key} = @${key}`);
      params[key] = value;
    } else {
      throw new Error(`updateRun: unknown field "${key}"`);
    }
  }
  if (sets.length > 0) {
    const res = getDb().prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = @id`).run(params);
    if (res.changes === 0) throw new Error(`Run ${id} not found`);
  }
  const run = getRun(id);
  if (!run) throw new Error(`Run ${id} not found`);
  return run;
}

export function markRunStarted(id: string): AgentRun {
  return updateRun(id, { status: 'running', started_at: new Date().toISOString() });
}

export function markRunDraftReady(id: string, patch: Omit<RunPatch, 'status' | 'draft_ready_at'> = {}): AgentRun {
  return updateRun(id, { ...patch, status: 'draft_ready', draft_ready_at: new Date().toISOString() });
}

export function markRunFinished(id: string, status: 'submitted' | 'conceded'): AgentRun {
  return updateRun(id, { status, finished_at: new Date().toISOString() });
}

export function markRunFailed(id: string, error: string): AgentRun {
  return updateRun(id, { status: 'failed', error: error.slice(0, 4000) });
}

export function addRunTokens(id: string, inputTokens: number, outputTokens: number): void {
  getDb()
    .prepare(
      `UPDATE agent_runs SET input_tokens = input_tokens + @i, output_tokens = output_tokens + @o WHERE id = @id`,
    )
    .run({ id, i: Math.max(0, Math.floor(inputTokens || 0)), o: Math.max(0, Math.floor(outputTokens || 0)) });
}

/** On boot, runs left queued/running by a dead process are failed so they stop blocking new runs. */
export function failOrphanedRuns(reason = 'Server restarted while the run was active'): number {
  const res = getDb()
    .prepare(`UPDATE agent_runs SET status = 'failed', error = ? WHERE status IN ('queued','running')`)
    .run(reason);
  return res.changes;
}