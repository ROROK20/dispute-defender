import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  let dbStatus: 'ok' | 'error' = 'ok';
  let dbError: string | undefined;
  try {
    getDb().prepare('SELECT 1 AS ok').get();
  } catch (e) {
    dbStatus = 'error';
    dbError = e instanceof Error ? e.message : String(e);
  }

  const body = {
    ok: dbStatus === 'ok',
    paypal_env: process.env.PAYPAL_ENV ?? 'sandbox',
    mock: {
      paypal: process.env.PAYPAL_MOCK === '1',
      anthropic: process.env.ANTHROPIC_MOCK === '1',
    },
    db: dbStatus,
    webhook_id_set: Boolean(process.env.PAYPAL_WEBHOOK_ID),
    ...(dbError ? { db_error: dbError } : {}),
  };

  return NextResponse.json(body, { status: dbStatus === 'ok' ? 200 : 503 });
}