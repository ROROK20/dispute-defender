import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { renderEvidencePdf } from '@/lib/pdf/render';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const db = getDb();
    let runId = new URL(req.url).searchParams.get('run');
    if (!runId) {
      const latest = db
        .prepare(
          "SELECT id FROM agent_runs WHERE dispute_id = ? AND draft_json IS NOT NULL ORDER BY clock_started_at DESC, rowid DESC LIMIT 1",
        )
        .get(id) as Row | undefined;
      runId = (latest?.id as string | undefined) ?? null;
    }
    if (!runId) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'No drafted run for this dispute yet' } }, { status: 404 });
    }
    const run = db.prepare('SELECT id, draft_json FROM agent_runs WHERE id = ? AND dispute_id = ?').get(runId, id) as Row | undefined;
    if (!run) return NextResponse.json({ error: { code: 'NOT_FOUND', message: `Run ${runId} not found` } }, { status: 404 });
    if (!run.draft_json) {
      return NextResponse.json({ error: { code: 'INVALID_STATE', message: 'The draft is not ready yet' } }, { status: 409 });
    }

    const pdf = await renderEvidencePdf(runId);
    const bytes = pdf instanceof Uint8Array ? pdf : new Uint8Array(pdf as ArrayBuffer);
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-length': String(bytes.byteLength),
        'content-disposition': `inline; filename="evidence-${id}.pdf"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'PDF_FAILED', message: e instanceof Error ? e.message : String(e) } },
      { status: 500 },
    );
  }
}