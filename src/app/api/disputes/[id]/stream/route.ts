import { NextRequest } from 'next/server';
import { EventEmitter } from 'node:events';
import '@/lib/bus';
import { getDb } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Row = Record<string, unknown>;

const TERMINAL = new Set(['draft_ready', 'failed', 'submitted', 'conceded']);

function getBus(): EventEmitter {
  const g = globalThis as unknown as { __ddBus?: EventEmitter };
  if (!g.__ddBus) {
    g.__ddBus = new EventEmitter();
    g.__ddBus.setMaxListeners(0);
  }
  return g.__ddBus;
}

function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeStep(s: Row) {
  return {
    seq: Number(s.seq),
    kind: s.kind,
    label: s.label,
    payload: 'payload' in s ? s.payload : parse(s.payload_json),
    duration_ms: s.duration_ms ?? null,
    created_at: s.created_at ?? new Date().toISOString(),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = getDb();
  let runId = new URL(req.url).searchParams.get('run');

  if (!runId) {
    const latest = db
      .prepare('SELECT id FROM agent_runs WHERE dispute_id = ? ORDER BY clock_started_at DESC, rowid DESC LIMIT 1')
      .get(id) as Row | undefined;
    runId = (latest?.id as string | undefined) ?? null;
  }
  if (!runId) {
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No run for this dispute' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }
  const run = db.prepare('SELECT id, status, draft_ready_at, finished_at FROM agent_runs WHERE id = ? AND dispute_id = ?').get(runId, id) as
    | Row
    | undefined;
  if (!run) {
    return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: `Run ${runId} not found` } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();
  const bus = getBus();
  const channel = `run:${runId}`;
  const stepStmt = db.prepare('SELECT * FROM agent_steps WHERE run_id = ? AND seq > ? ORDER BY seq ASC');
  const runStmt = db.prepare('SELECT status, draft_ready_at, finished_at FROM agent_runs WHERE id = ?');

  let cleanup: () => void = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastSeq = 0;
      const timers: { heartbeat?: ReturnType<typeof setInterval> } = {};

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const send = (event: string, data: unknown) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const sendStep = (raw: Row) => {
        const step = normalizeStep(raw);
        if (!Number.isFinite(step.seq) || step.seq <= lastSeq) return;
        lastSeq = step.seq;
        send('step', step);
      };

      const flushBacklog = () => {
        for (const s of stepStmt.all(runId, lastSeq) as Row[]) sendStep(s);
      };

      const finishIfTerminal = (status: unknown) => {
        if (typeof status === 'string' && TERMINAL.has(status)) {
          flushBacklog();
          send('done', {});
          cleanup();
          try {
            controller.close();
          } catch {
            /* stream already closed by client */
          }
        }
      };

      const sendStatus = () => {
        const r = runStmt.get(runId) as Row | undefined;
        if (!r) return;
        send('status', { status: r.status, draft_ready_at: r.draft_ready_at ?? undefined, finished_at: r.finished_at ?? undefined });
        finishIfTerminal(r.status);
      };

      const listener = (msg: unknown) => {
        if (closed || !msg || typeof msg !== 'object') return;
        const m = msg as Row;
        const type = (m.type ?? m.event) as string | undefined;
        if (type === 'done') {
          sendStatus();
          return;
        }
        if (type === 'status' || (!('seq' in m) && 'status' in m && !m.step)) {
          // Steps are written to the DB before they are emitted, so flush any we haven't seen first.
          flushBacklog();
          sendStatus();
          return;
        }
        const stepCandidate = (m.step ?? m.data ?? m) as Row;
        if (stepCandidate && typeof stepCandidate === 'object' && 'seq' in stepCandidate) {
          if (Number(stepCandidate.seq) > lastSeq + 1) flushBacklog();
          sendStep(stepCandidate);
        }
      };

      cleanup = () => {
        if (closed) return;
        closed = true;
        bus.off(channel, listener);
        if (timers.heartbeat) clearInterval(timers.heartbeat);
      };

      // Subscribe before reading the backlog so nothing emitted in between is lost; seq dedupes.
      bus.on(channel, listener);
      write('retry: 3000\n\n');
      try {
        flushBacklog();
        sendStatus();
      } catch (e) {
        send('error', { message: e instanceof Error ? e.message : String(e) });
      }

      timers.heartbeat = setInterval(() => write(':ping\n\n'), 15_000);
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}