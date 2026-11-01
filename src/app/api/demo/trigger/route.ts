import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { getDb } from '@/lib/db';
import { enqueueRun } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Bucket = { tokens: number; updatedAt: number };
type Buckets = Map<string, Bucket>;

function buckets(): Buckets {
  const g = globalThis as unknown as { __ddDemoBuckets?: Buckets };
  if (!g.__ddDemoBuckets) g.__ddDemoBuckets = new Map();
  return g.__ddDemoBuckets;
}

/** Token bucket: `capacity` tokens refilled evenly over `windowMs`. Returns ms until a token is available, or 0 if taken. */
function take(key: string, capacity: number, windowMs: number): number {
  const map = buckets();
  const now = Date.now();
  const rate = capacity / windowMs;
  const b = map.get(key) ?? { tokens: capacity, updatedAt: now };
  b.tokens = Math.min(capacity, b.tokens + (now - b.updatedAt) * rate);
  b.updatedAt = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    map.set(key, b);
    return 0;
  }
  map.set(key, b);
  return Math.ceil((1 - b.tokens) / rate);
}

function refund(key: string) {
  const b = buckets().get(key);
  if (b) b.tokens += 1;
}

function fail(status: number, code: string, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: { code, message, ...(extra ?? {}) } }, { status });
}

export async function POST(req: NextRequest) {
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'local';
  const perIp = Math.max(1, Number(process.env.DEMO_TRIGGER_PER_IP_PER_MIN ?? 1));
  const global = Math.max(1, Number(process.env.DEMO_TRIGGER_GLOBAL_PER_HOUR ?? 10));

  const ipKey = `ip:${ip}`;
  const ipWait = take(ipKey, perIp, 60_000);
  if (ipWait > 0) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: `Demo trigger is limited to ${perIp}/min per visitor. Try again in ${Math.ceil(ipWait / 1000)} s.` } },
      { status: 429, headers: { 'retry-after': String(Math.ceil(ipWait / 1000)) } },
    );
  }
  const globalWait = take('global', global, 3_600_000);
  if (globalWait > 0) {
    refund(ipKey);
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: `Demo trigger is limited to ${global}/hour across all visitors.` } },
      { status: 429, headers: { 'retry-after': String(Math.ceil(globalWait / 1000)) } },
    );
  }

  try {
    const db = getDb();
    const pick = db
      .prepare(
        `SELECT d.id FROM disputes d
          WHERE d.source = 'paypal_sandbox'
            AND d.status = 'WAITING_FOR_SELLER_RESPONSE'
            AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispute_id = d.id)
          ORDER BY COALESCE(d.pp_created_at, d.last_synced_at) ASC LIMIT 1`,
      )
      .get() as { id: string } | undefined;

    if (!pick) {
      refund(ipKey);
      refund('global');
      return fail(
        409,
        'POOL_EMPTY',
        'No staged sandbox disputes are waiting. Restock the pool: buy an item on /store with the sandbox buyer wallet, open a dispute in the sandbox Resolution Center (docs/sandbox-staging.md), then press "Sync from PayPal".',
        { restock_doc: 'docs/sandbox-staging.md' },
      );
    }

    const eventId = `demo_${nanoid(12)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO webhook_events (id, source, event_type, resource_id, verified, verification_status, received_at, raw_json)
       VALUES (?, 'demo_trigger', 'CUSTOMER.DISPUTE.CREATED', ?, 0, 'N/A', ?, ?)`,
    ).run(eventId, pick.id, now, JSON.stringify({ note: 'Demo trigger (not a PayPal webhook)', dispute_id: pick.id, ip_hash: ip === 'local' ? 'local' : 'redacted' }));

    const runId = await enqueueRun(pick.id, eventId);
    db.prepare('UPDATE webhook_events SET processed_at = ? WHERE id = ?').run(new Date().toISOString(), eventId);

    return NextResponse.json({ run_id: runId, dispute_id: pick.id, event_id: eventId, source: 'demo_trigger' }, { status: 202 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) return fail(409, 'RUN_ACTIVE', 'That dispute already has a run in progress. Try again.');
    return fail(500, 'INTERNAL', msg);
  }
}