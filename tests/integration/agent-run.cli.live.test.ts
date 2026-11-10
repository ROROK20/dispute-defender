import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * LIVE: the real agent with real Claude output through the local Claude Code
 * CLI (ANTHROPIC_PROVIDER=claude-cli), against mock PayPal fixtures.
 * Skipped unless LIVE_CLI=1, because it needs a signed-in `claude` CLI and
 * takes minutes. Run: LIVE_CLI=1 npx vitest run tests/integration/agent-run.cli.live.test.ts
 */
const LIVE = process.env.LIVE_CLI === '1';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-cli-'));

if (LIVE) {
  process.env.PAYPAL_MOCK = '1';
  process.env.ANTHROPIC_MOCK = '0';
  process.env.ANTHROPIC_PROVIDER = 'claude-cli';
  process.env.PAYPAL_ENV = 'sandbox';
  process.env.PAYPAL_CLIENT_ID ??= 'test-client';
  process.env.PAYPAL_CLIENT_SECRET ??= 'test-secret';
  process.env.REVIEW_ENABLED = process.env.REVIEW_ENABLED ?? 'true';
  process.env.DATABASE_PATH = path.join(tmpDir, 'app.db');
}

const DISPUTE_ID = 'PP-D-LIVE-INR';
let db: Database.Database;

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the run');
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!LIVE)('agent run (mock PayPal + real Claude via the local CLI)', () => {
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
       VALUES ('demo_live1','demo_trigger','CUSTOMER.DISPUTE.CREATED',?,0,'N/A',?,'{}')`,
    ).run(DISPUTE_ID, now);
  });

  afterAll(() => {
    try { db?.close(); } catch { /* closed */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reaches draft_ready with every sentence cited to a stored source', async () => {
    const started = Date.now();
    const { enqueueRun } = await import('../../src/lib/jobs');
    await enqueueRun(DISPUTE_ID, 'demo_live1');
    const run = await waitFor(() => {
      const r = db
        .prepare(`SELECT * FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC LIMIT 1`)
        .get(DISPUTE_ID) as Record<string, unknown> | undefined;
      return r && (r.status === 'draft_ready' || r.status === 'failed') ? r : undefined;
    }, 1_500_000);

    const steps = db.prepare(`SELECT seq, kind, label FROM agent_steps WHERE run_id = ? ORDER BY seq`).all(run.id) as {
      seq: number; kind: string; label: string;
    }[];
    const sources = db.prepare(`SELECT source_key FROM sources WHERE run_id = ?`).all(run.id) as { source_key: string }[];
    const draft = run.draft_json ? JSON.parse(String(run.draft_json)) : null;
    const report = {
      seconds: Math.round((Date.now() - started) / 1000),
      status: run.status,
      error: run.error ?? null,
      model_agent: run.model_agent,
      recommendation: run.recommendation,
      steps: steps.length,
      tool_calls: steps.filter((s) => s.kind === 'tool_call').length,
      sources: sources.length,
      sentences: draft?.sentences?.length ?? 0,
    };
    fs.writeFileSync(path.join(process.cwd(), 'data', 'live-cli-run.json'), JSON.stringify({ report, draft, steps }, null, 2));
    console.log('[live-cli]', JSON.stringify(report));

    expect(run.error ?? null).toBeNull();
    expect(run.status).toBe('draft_ready');
    expect(String(run.model_agent)).not.toMatch(/^mock:/);
    const keys = new Set(sources.map((s) => s.source_key));
    expect(draft.sentences.length).toBeGreaterThan(0);
    for (const s of draft.sentences) {
      expect(s.source_ids.length).toBeGreaterThan(0);
      for (const id of s.source_ids) expect(keys.has(id)).toBe(true);
    }
    expect(steps.some((s) => s.kind === 'tool_call')).toBe(true);
  }, 1_600_000);
});
