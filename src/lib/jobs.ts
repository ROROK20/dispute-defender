import { getDb, isUniqueViolation, nowIso } from "./db";
import { getEnv } from "./env";
import { newRunId } from "./ids";
import { emitDone, emitStatus, emitStep } from "./bus";
import { runAgent } from "./agent/runner";

export class RunActiveError extends Error {
  readonly code = "RUN_ACTIVE";
  constructor(
    readonly disputeId: string,
    readonly activeRunId: string | null,
  ) {
    super(`Dispute ${disputeId} already has an active agent run${activeRunId ? ` (${activeRunId})` : ""}.`);
    this.name = "RunActiveError";
  }
}

export class DisputeNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  constructor(readonly disputeId: string) {
    super(`Dispute ${disputeId} is not in the local database. Sync disputes first.`);
    this.name = "DisputeNotFoundError";
  }
}

const g = globalThis as unknown as { __ddActiveDisputes?: Set<string> };
const executing: Set<string> = g.__ddActiveDisputes ?? (g.__ddActiveDisputes = new Set());

export function activeRunFor(disputeId: string): { id: string; status: string } | null {
  const row = getDb()
    .prepare(
      `SELECT id, status FROM agent_runs WHERE dispute_id = ? AND status IN ('queued','running')
       ORDER BY clock_started_at DESC LIMIT 1`,
    )
    .get(disputeId) as { id: string; status: string } | undefined;
  return row ?? null;
}

export function hasAnyRun(disputeId: string): boolean {
  const row = getDb().prepare(`SELECT 1 AS x FROM agent_runs WHERE dispute_id = ? LIMIT 1`).get(disputeId);
  return Boolean(row);
}

export function isExecuting(disputeId: string): boolean {
  return executing.has(disputeId);
}

function nextSeq(runId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM agent_steps WHERE run_id = ?`)
    .get(runId) as { next: number };
  return row.next;
}

function writeErrorStep(runId: string, label: string, payload: unknown): void {
  const db = getDb();
  const createdAt = nowIso();
  for (let attempt = 0; attempt < 3; attempt++) {
    const seq = nextSeq(runId);
    try {
      db.prepare(
        `INSERT INTO agent_steps (run_id, seq, kind, label, payload_json, duration_ms, created_at)
         VALUES (?, ?, 'error', ?, ?, NULL, ?)`,
      ).run(runId, seq, label, JSON.stringify(payload ?? null), createdAt);
      emitStep(runId, { seq, kind: "error", label, payload, duration_ms: null, created_at: createdAt });
      return;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error(`[jobs] could not write error step for ${runId}:`, err);
        return;
      }
    }
  }
}

/** Marks a queued/running run as failed, records an error step and closes the stream. */
export function failRun(runId: string, message: string): void {
  const db = getDb();
  const res = db
    .prepare(`UPDATE agent_runs SET status = 'failed', error = ? WHERE id = ? AND status IN ('queued','running')`)
    .run(message, runId);
  if (res.changes === 0) return;
  writeErrorStep(runId, `Run failed: ${message}`, { error: message });
  emitStatus(runId, { status: "failed", error: message });
  emitDone(runId);
}

/** Runs whose process died (e.g. a restart) stay 'running' forever; free them. */
function releaseStaleActiveRuns(disputeId: string): void {
  if (executing.has(disputeId)) return;
  const stale = getDb()
    .prepare(`SELECT id FROM agent_runs WHERE dispute_id = ? AND status IN ('queued','running')`)
    .all(disputeId) as { id: string }[];
  for (const r of stale) failRun(r.id, "Run was interrupted (server restarted) and has been released.");
}

export interface EnqueueOptions {
  /** Release a stuck run left behind by a crashed process before queueing. */
  force?: boolean;
}

/**
 * Creates a queued agent run for the dispute and starts it on the next tick.
 * The stopwatch clock starts at the trigger event's received_at.
 * Throws RunActiveError if a run is already queued or running.
 */
export function enqueueRun(disputeId: string, eventId: string | null, opts: EnqueueOptions = {}): string {
  const db = getDb();
  const env = getEnv();

  const dispute = db.prepare(`SELECT id FROM disputes WHERE id = ?`).get(disputeId);
  if (!dispute) throw new DisputeNotFoundError(disputeId);

  if (opts.force) releaseStaleActiveRuns(disputeId);

  let clockStartedAt = nowIso();
  if (eventId) {
    const ev = db.prepare(`SELECT received_at FROM webhook_events WHERE id = ?`).get(eventId) as
      | { received_at: string }
      | undefined;
    if (ev?.received_at) clockStartedAt = ev.received_at;
  }

  const runId = newRunId();
  try {
    db.prepare(
      `INSERT INTO agent_runs (id, dispute_id, trigger_event_id, status, clock_started_at, model_agent, model_review)
       VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(
      runId,
      disputeId,
      eventId,
      clockStartedAt,
      env.ANTHROPIC_MOCK ? `mock:${env.ANTHROPIC_MODEL_AGENT}` : env.ANTHROPIC_MODEL_AGENT,
      env.REVIEW_ENABLED ? (env.ANTHROPIC_MOCK ? `mock:${env.ANTHROPIC_MODEL_REVIEW}` : env.ANTHROPIC_MODEL_REVIEW) : null,
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new RunActiveError(disputeId, activeRunFor(disputeId)?.id ?? null);
    throw err;
  }

  emitStatus(runId, { status: "queued" });
  setImmediate(() => {
    void execute(runId, disputeId, eventId);
  });
  return runId;
}

async function execute(runId: string, disputeId: string, eventId: string | null): Promise<void> {
  if (executing.has(disputeId)) {
    failRun(runId, "Another run for this dispute is already executing.");
    return;
  }
  executing.add(disputeId);
  try {
    if (eventId) {
      try {
        getDb()
          .prepare(`UPDATE webhook_events SET processed_at = COALESCE(processed_at, ?) WHERE id = ?`)
          .run(nowIso(), eventId);
      } catch (err) {
        console.warn(`[jobs] could not mark event ${eventId} processed:`, err);
      }
    }
    await runAgent(runId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[jobs] run ${runId} for ${disputeId} failed:`, err);
    failRun(runId, message);
  } finally {
    executing.delete(disputeId);
    const row = getDb().prepare(`SELECT status FROM agent_runs WHERE id = ?`).get(runId) as
      | { status: string }
      | undefined;
    if (row && (row.status === "queued" || row.status === "running")) {
      failRun(runId, "Agent finished without producing a draft.");
    }
  }
}