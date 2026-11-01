import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { minePatterns } from '@/lib/patterns/mine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

export async function POST() {
  try {
    await minePatterns();
    const rows = getDb()
      .prepare(
        `SELECT p.*, s.name AS sku_name FROM patterns p LEFT JOIN skus s ON s.sku = p.sku
          ORDER BY p.matching_count DESC, p.dispute_count DESC`,
      )
      .all() as Row[];
    const patterns = rows.map(({ quotes_json, ...rest }) => {
      let quotes: unknown[] = [];
      try {
        quotes = JSON.parse(String(quotes_json ?? '[]'));
      } catch {
        quotes = [];
      }
      return { ...rest, includes_fixture: Boolean(rest.includes_fixture), quotes };
    });
    return NextResponse.json({ patterns });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'MINE_FAILED', message: e instanceof Error ? e.message : String(e) } },
      { status: 502 },
    );
  }
}