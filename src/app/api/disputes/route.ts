import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

function msBetween(from: unknown, to: unknown): number | null {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, b - a);
}

export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    const url = new URL(req.url);
    const where: string[] = [];
    const args: string[] = [];
    for (const key of ['status', 'reason', 'sku'] as const) {
      const v = url.searchParams.get(key);
      if (v) {
        where.push(`d.${key} = ?`);
        args.push(v);
      }
    }

    const rows = db
      .prepare(
        `SELECT d.id, d.source, d.reason, d.status, d.stage, d.amount_cents, d.currency, d.sku,
                s.name AS sku_name, o.buyer_name, d.seller_response_due_at, d.strength_score, d.recommendation,
                d.outcome, d.pp_created_at
           FROM disputes d
           LEFT JOIN skus s ON s.sku = d.sku
           LEFT JOIN orders o ON o.id = d.order_id
          ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY CASE WHEN d.seller_response_due_at IS NULL THEN 1 ELSE 0 END,
                   d.seller_response_due_at ASC, d.pp_created_at DESC`,
      )
      .all(...args) as Row[];

    const latestRun = db.prepare(
      `SELECT id, status, clock_started_at, draft_ready_at, finished_at
         FROM agent_runs WHERE dispute_id = ?
        ORDER BY clock_started_at DESC, rowid DESC LIMIT 1`,
    );

    const disputes = rows.map((r) => {
      const run = latestRun.get(r.id as string) as Row | undefined;
      return {
        ...r,
        latest_run: run
          ? {
              id: run.id as string,
              status: run.status as string,
              draft_ready_ms: msBetween(run.clock_started_at, run.draft_ready_at),
              submitted_ms: msBetween(run.clock_started_at, run.finished_at),
            }
          : null,
      };
    });

    return NextResponse.json({ disputes });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}