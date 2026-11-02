import { getDb, nowIso } from "./db";
import { getEnv, paypalAvailable } from "./env";
import { centsFromValue } from "./format";
import { newPollEventId } from "./ids";
import { enqueueRun, hasAnyRun, RunActiveError } from "./jobs";
import { getDispute, listDisputes } from "./paypal/disputes";

export interface PaypalDisputeLike {
  dispute_id: string;
  reason?: string;
  status?: string;
  dispute_life_cycle_stage?: string;
  dispute_amount?: { currency_code?: string; value?: string };
  seller_response_due_date?: string;
  create_time?: string;
  update_time?: string;
  dispute_outcome?: { outcome_code?: string };
  disputed_transactions?: {
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    items?: { item_id?: string; item_name?: string; item_description?: string }[];
  }[];
}

export interface UpsertResult {
  id: string;
  isNew: boolean;
  previousStatus: string | null;
  status: string;
}

export interface SyncResult {
  synced: number;
  new_runs: string[];
}

function asDispute(raw: unknown): PaypalDisputeLike {
  if (!raw || typeof raw !== "object" || typeof (raw as { dispute_id?: unknown }).dispute_id !== "string") {
    throw new Error("PayPal returned a dispute without dispute_id");
  }
  return raw as PaypalDisputeLike;
}

function asDisputeList(raw: unknown): PaypalDisputeLike[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : [];
  return items.filter(
    (d): d is PaypalDisputeLike =>
      Boolean(d) && typeof d === "object" && typeof (d as { dispute_id?: unknown }).dispute_id === "string",
  );
}

function skuExists(sku: string | null | undefined): sku is string {
  if (!sku) return false;
  return Boolean(getDb().prepare(`SELECT 1 AS x FROM skus WHERE sku = ?`).get(sku));
}

/** Writes PayPal's view of a dispute; never touches agent-owned columns. */
export function upsertDisputeFromPaypal(raw: unknown): UpsertResult {
  const d = asDispute(raw);
  const db = getDb();
  const txn = d.disputed_transactions?.[0];
  const captureId = txn?.seller_transaction_id ?? null;

  const order = captureId
    ? (db.prepare(`SELECT id, sku FROM orders WHERE capture_id = ?`).get(captureId) as
        | { id: string; sku: string | null }
        | undefined)
    : undefined;

  const itemSku = txn?.items?.find((i) => skuExists(i.item_id))?.item_id ?? null;
  const sku = skuExists(order?.sku) ? order!.sku : itemSku;

  const existing = db.prepare(`SELECT status, source FROM disputes WHERE id = ?`).get(d.dispute_id) as
    | { status: string; source: string }
    | undefined;
  if (existing?.source === "fixture") {
    return { id: d.dispute_id, isNew: false, previousStatus: existing.status, status: existing.status };
  }

  const status = d.status ?? "OPEN";
  db.prepare(
    `INSERT INTO disputes (id, source, order_id, capture_id, sku, reason, stage, status, outcome, amount_cents, currency,
       seller_response_due_at, pp_created_at, pp_updated_at, last_synced_at, raw_json)
     VALUES (@id, 'paypal_sandbox', @order_id, @capture_id, @sku, @reason, @stage, @status, @outcome, @amount_cents, @currency,
       @due, @created, @updated, @synced, @raw)
     ON CONFLICT(id) DO UPDATE SET
       order_id = COALESCE(excluded.order_id, disputes.order_id),
       capture_id = COALESCE(excluded.capture_id, disputes.capture_id),
       sku = COALESCE(excluded.sku, disputes.sku),
       reason = excluded.reason,
       stage = excluded.stage,
       status = excluded.status,
       outcome = excluded.outcome,
       amount_cents = excluded.amount_cents,
       currency = excluded.currency,
       seller_response_due_at = excluded.seller_response_due_at,
       pp_created_at = COALESCE(excluded.pp_created_at, disputes.pp_created_at),
       pp_updated_at = excluded.pp_updated_at,
       last_synced_at = excluded.last_synced_at,
       raw_json = excluded.raw_json`,
  ).run({
    id: d.dispute_id,
    order_id: order?.id ?? null,
    capture_id: captureId,
    sku: sku ?? null,
    reason: d.reason ?? "OTHER",
    stage: d.dispute_life_cycle_stage ?? null,
    status,
    outcome: d.dispute_outcome?.outcome_code ?? null,
    amount_cents: centsFromValue(d.dispute_amount?.value),
    currency: d.dispute_amount?.currency_code ?? "USD",
    due: d.seller_response_due_date ?? null,
    created: d.create_time ?? null,
    updated: d.update_time ?? null,
    synced: nowIso(),
    raw: JSON.stringify(d),
  });

  return { id: d.dispute_id, isNew: !existing, previousStatus: existing?.status ?? null, status };
}

/** Re-fetches one dispute from PayPal and stores it. */
export async function syncDispute(disputeId: string): Promise<UpsertResult> {
  const raw = await getDispute(disputeId);
  return upsertDisputeFromPaypal(raw);
}

/**
 * Starts a run for a live dispute that needs a seller response and has never
 * had one. Records a synthetic, clearly labelled event first so the stopwatch
 * starts at detection time. Returns the run id or null.
 */
export function ensureRunForWaitingDispute(
  disputeId: string,
  source: "poll" | "paypal" = "poll",
  eventId?: string,
): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT source, status FROM disputes WHERE id = ?`).get(disputeId) as
    | { source: string; status: string }
    | undefined;
  if (!row || row.source !== "paypal_sandbox" || row.status !== "WAITING_FOR_SELLER_RESPONSE") return null;
  if (hasAnyRun(disputeId)) return null;

  let triggerId = eventId ?? null;
  if (!triggerId) {
    triggerId = newPollEventId();
    db.prepare(
      `INSERT INTO webhook_events (id, source, event_type, resource_id, verified, verification_status, received_at, raw_json)
       VALUES (?, ?, 'POLL.DISPUTE.DETECTED', ?, 0, 'N/A', ?, ?)`,
    ).run(
      triggerId,
      source,
      disputeId,
      nowIso(),
      JSON.stringify({ synthetic: true, note: "Detected by the dispute poller, not a PayPal webhook", dispute_id: disputeId }),
    );
  }

  try {
    return enqueueRun(disputeId, triggerId);
  } catch (err) {
    if (err instanceof RunActiveError) return null;
    throw err;
  }
}

export interface SyncOptions {
  /**
   * Start an agent run for disputes that first appear while this process is
   * running (the poller, C4). Off for one-shot syncs (setup, CLI, the manual
   * sync route): a script's process exits and would orphan the run.
   */
  autoRun?: boolean;
}

const g = globalThis as unknown as {
  __ddSyncCursor?: string;
  __ddSyncSeeded?: boolean;
  __ddSyncInFlight?: Promise<SyncResult> | null;
  __ddPollerStarted?: boolean;
  __ddPollerTimer?: ReturnType<typeof setInterval>;
};

async function doSync(opts: SyncOptions): Promise<SyncResult> {
  const passStartedAt = Date.now();
  const cursor = g.__ddSyncCursor;
  // The first pass of a process only seeds: disputes already staged when the
  // server boots stay in the demo-trigger pool (C13) instead of being run here.
  const seeding = !g.__ddSyncSeeded;
  const summaries = asDisputeList(await listDisputes(cursor ? { updateTimeAfter: cursor } : {}));
  const db = getDb();

  let synced = 0;
  const newRuns: string[] = [];
  for (const summary of summaries) {
    try {
      const stored = db.prepare(`SELECT pp_updated_at FROM disputes WHERE id = ?`).get(summary.dispute_id) as
        | { pp_updated_at: string | null }
        | undefined;
      if (stored && summary.update_time && stored.pp_updated_at === summary.update_time) {
        db.prepare(`UPDATE disputes SET last_synced_at = ? WHERE id = ?`).run(nowIso(), summary.dispute_id);
      } else {
        await syncDispute(summary.dispute_id);
      }
      synced++;
      if (opts.autoRun && !seeding && !stored) {
        const runId = ensureRunForWaitingDispute(summary.dispute_id, "poll");
        if (runId) newRuns.push(runId);
      }
    } catch (err) {
      console.warn(`[sync] dispute ${summary.dispute_id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  g.__ddSyncCursor = new Date(passStartedAt - 60_000).toISOString();
  g.__ddSyncSeeded = true;
  return { synced, new_runs: newRuns };
}

/** Pulls disputes changed since the last pass. Concurrent callers share one pass. */
export function syncDisputes(opts: SyncOptions = {}): Promise<SyncResult> {
  if (g.__ddSyncInFlight) return g.__ddSyncInFlight;
  const p = doSync(opts).finally(() => {
    g.__ddSyncInFlight = null;
  });
  g.__ddSyncInFlight = p;
  return p;
}

export function resetSyncCursor(): void {
  g.__ddSyncCursor = undefined;
  g.__ddSyncSeeded = undefined;
}

/** Background poller (C4); started once per process from instrumentation.ts. */
export function startPoller(): void {
  if (g.__ddPollerStarted) return;
  g.__ddPollerStarted = true;

  if (!paypalAvailable()) {
    console.warn("[sync] PayPal credentials not set and PAYPAL_MOCK is off; dispute poller disabled.");
    return;
  }

  const interval = getEnv().POLL_INTERVAL_MS;
  const tick = async () => {
    try {
      const res = await syncDisputes({ autoRun: true });
      if (res.new_runs.length > 0) {
        console.info(`[sync] poll synced ${res.synced} dispute(s), started ${res.new_runs.length} run(s)`);
      }
    } catch (err) {
      console.warn("[sync] poll failed:", err instanceof Error ? err.message : err);
    }
  };

  const first = setTimeout(() => void tick(), 3_000);
  first.unref?.();
  g.__ddPollerTimer = setInterval(() => void tick(), interval);
  g.__ddPollerTimer.unref?.();
}

export function stopPoller(): void {
  if (g.__ddPollerTimer) clearInterval(g.__ddPollerTimer);
  g.__ddPollerTimer = undefined;
  g.__ddPollerStarted = false;
}