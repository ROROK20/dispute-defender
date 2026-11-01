import { NextResponse } from 'next/server';
import { syncDisputes } from '@/lib/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const result = (await syncDisputes()) as unknown as Record<string, unknown> | number | undefined;
    let synced = 0;
    let newRuns: string[] = [];
    if (typeof result === 'number') {
      synced = result;
    } else if (result && typeof result === 'object') {
      synced = Number(result.synced ?? 0);
      const nr = result.new_runs ?? result.newRuns;
      if (Array.isArray(nr)) newRuns = nr.map(String);
    }
    return NextResponse.json({ synced, new_runs: newRuns });
  } catch (e) {
    const err = e as { message?: string; debugId?: string; debug_id?: string };
    const debugId = err.debugId ?? err.debug_id;
    return NextResponse.json(
      {
        error: {
          code: 'SYNC_FAILED',
          message: err.message ?? String(e),
          ...(debugId ? { debug_id: debugId } : {}),
        },
      },
      { status: 502 },
    );
  }
}