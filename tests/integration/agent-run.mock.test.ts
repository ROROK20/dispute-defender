import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-agent-'));

process.env.PAYPAL_MOCK = '1';
process.env.ANTHROPIC_MOCK = '1';
process.env.PAYPAL_ENV = 'sandbox';
process.env.PAYPAL_CLIENT_ID ??= 'test-client';
process.env.PAYPAL_CLIENT_SECRET ??= 'test-secret';
process.env.PAYPAL_WEBHOOK_ID ??= 'WH-TEST';
process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID ??= 'test-client';
process.env.ANTHROPIC_API_KEY ??= 'test-key';
process.env.REVIEW_ENABLED = 'false';
process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');

const DISPUTE_ID = 'PP-D-MOCK-INR';
let db: Database.Database;

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  const dbMod = await import('../../src/lib/db');
  db = dbMod.getDb();
  const now = new Date().toISOString();
  const fixture = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'data/fixtures/mock-paypal/dispute-inr.json'), 'utf8'),
  );
  const raw = { ...fixture, dispute_id: DISPUTE_ID };

  db.prepare(
    `INSERT OR IGNORE INTO skus (sku,name,category,price_cents,cogs_cents,description,size_chart_version)
     VALUES ('JT-114','Linen Wrap Dress','dresses',6400,2200,'Midi wrap dress in washed linen.','v2')`,
  ).run();
  db.prepare(
    `INSERT INTO disputes (id,source,reason,status,amount_cents,currency,seller_response_due_at,last_synced_at,raw_json,sku,capture_id)
     VALUES (?, 'paypal_sandbox', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', 'WAITING_FOR_SELLER_RESPONSE', 6400, 'USD', ?, ?, ?, 'JT-114', ?)`,
  ).run(
    DISPUTE_ID,
    new Date(Date.now() + 7 * 86400_000).toISOString(),
    now,
    JSON.stringify(raw),
    raw?.disputed_transactions?.[0]?.seller_transaction_id ?? null,
  );
  db.prepare(
    `INSERT INTO webhook_events (id,source,event_type,resource_id,verified,verification_status,received_at,raw_json)
     VALUES ('demo_test1','demo_trigger','CUSTOMER.DISPUTE.CREATED',?,0,'N/A',?,'{}')`,
  ).run(DISPUTE_ID, now);
});

afterAll(() => {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('agent run (mock PayPal + mock Claude)', () => {
  it('runs to draft_ready with stored steps, sources and cited sentences', async () => {
    const { enqueueRun } = await import('../../src/lib/jobs');
    await enqueueRun(DISPUTE_ID, 'demo_test1');

    const run = await waitFor(() => {
      const r = db
        .prepare(`SELECT * FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC LIMIT 1`)
        .get(DISPUTE_ID) as Record<string, unknown> | undefined;
      return r && (r.status === 'draft_ready' || r.status === 'failed') ? r : undefined;
    });

    expect(run.error ?? null).toBeNull();
    expect(run.status).toBe('draft_ready');
    expect(run.trigger_event_id).toBe('demo_test1');
    expect(run.draft_ready_at).toBeTruthy();
    expect(['FIGHT', 'ACCEPT_CLAIM', 'MAKE_OFFER']).toContain(run.recommendation);

    const strength = JSON.parse(String(run.strength_json));
    expect(strength.score).toBeGreaterThanOrEqual(0);
    expect(strength.score).toBeLessThanOrEqual(100);

    const ev = JSON.parse(String(run.ev_json));
    expect(ev.options.length).toBe(3);
    expect(run.recommendation).toBe(ev.recommended);

    const sources = db.prepare(`SELECT * FROM sources WHERE run_id = ?`).all(run.id) as {
      source_key: string;
      content: string;
    }[];
    expect(sources.length).toBeGreaterThan(0);
    const keys = new Set(sources.map((s) => s.source_key));

    const draft = JSON.parse(String(run.draft_json));
    expect(Array.isArray(draft.sentences)).toBe(true);
    for (const s of draft.sentences) {
      expect(s.source_ids.length).toBeGreaterThan(0);
      for (const id of s.source_ids) expect(keys.has(id)).toBe(true);
    }

    const steps = db.prepare(`SELECT seq, kind FROM agent_steps WHERE run_id = ? ORDER BY seq`).all(run.id) as {
      seq: number;
      kind: string;
    }[];
    expect(steps.length).toBeGreaterThan(2);
    steps.forEach((s, i) => expect(s.seq).toBe(steps[0].seq + i));
    expect(steps.some((s) => s.kind === 'tool_call')).toBe(true);
    expect(steps.some((s) => s.kind === 'check')).toBe(true);
  });

  it('refuses a second active run for the same dispute', () => {
    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO agent_runs (id,dispute_id,status,clock_started_at,model_agent) VALUES (?,?,?,?,?)`,
    );
    insert.run('run_active_a', DISPUTE_ID, 'running', now, 'mock');
    expect(() => insert.run('run_active_b', DISPUTE_ID, 'queued', now, 'mock')).toThrow();
    db.prepare(`UPDATE agent_runs SET status='failed' WHERE id='run_active_a'`).run();
  });

  it('never writes a PayPal mutating call during the agent run', () => {
    const calls = db
      .prepare(`SELECT method, path FROM paypal_calls WHERE dispute_id = ?`)
      .all(DISPUTE_ID) as { method: string; path: string }[];
    for (const c of calls) {
      expect(c.path).not.toMatch(/provide-evidence|accept-claim|make-offer|send-message/);
    }
  });
});