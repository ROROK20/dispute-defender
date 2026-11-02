'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

type Step = { seq: number; kind: string; label: string; payload: unknown; duration_ms: number | null; created_at: string };
type Source = { source_key: string; kind: string; title: string; content: string; ref: string | null; fetched_at: string };
type Sentence = { id: string; text: string; source_ids: string[] };
type Removed = { id: string; text: string; reason: string };
type StrengthItem = { key: string; label: string; weight: number; present: boolean; source_ids: string[] };
type EvOption = { action: string; expected_cost_cents: number; formula: string; label?: string };
type Run = {
  id: string;
  status: string;
  clock_started_at: string;
  draft_ready_at: string | null;
  finished_at: string | null;
  model_agent: string;
  model_review: string | null;
  review_applied: number;
  recommendation: string | null;
  error: string | null;
  classification: { reason?: string; sub_theme?: string; evidence_needed?: string[] } | null;
  strength: { score: number; items: StrengthItem[] } | null;
  ev: { inputs?: Record<string, unknown>; options: EvOption[]; recommended: string } | null;
  draft: { sentences: Sentence[]; removed?: Removed[] } | null;
  citation_check: { rounds?: number; passed?: boolean } | null;
};
type Detail = {
  dispute: {
    id: string;
    source: string;
    reason: string;
    stage: string | null;
    status: string;
    outcome: string | null;
    amount_cents: number;
    currency: string;
    sku: string | null;
    seller_response_due_at: string | null;
  };
  order: { id: string; buyer_name: string | null; tracking_number: string | null; carrier: string | null } | null;
  sku: { sku: string; name: string } | null;
  run: Run | null;
  trigger_event: { source: string; event_type: string; verified: number } | null;
  steps: Step[];
  sources: Source[];
  decisions: { id: string; action: string; result: string; created_at: string }[];
  paypal_calls: { id: number; method: string; path: string; status_code: number | null; debug_id: string | null }[];
};
type Outcome = { kind: 'ok' | 'err'; title: string; status_code?: number | null; debug_id?: string | null; elapsed_ms?: number | null };

const REASON_LABEL: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorised',
};

function money(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function since(from: string, to: string | number) {
  return (typeof to === 'number' ? to : Date.parse(to)) - Date.parse(from);
}

/** 47h 10m under two days, 3d 4h beyond (the deadline badge on the inbox uses the same steps). */
function dueSpan(ms: number): string {
  const min = Math.floor(ms / 60e3);
  const h = Math.floor(min / 60);
  return h < 48 ? `${h}h ${min % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

type CitationFailureBody = { id: string; reason: string; token?: string };
type ApiBody = {
  error?: { code?: string; message?: string; debug_id?: string; failures?: CitationFailureBody[]; details?: { failed?: CitationFailureBody[] } };
  paypal?: { status_code?: number | null; debug_id?: string | null };
  elapsed_ms?: number | null;
  dispute_status?: string;
};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as ApiBody;
  return { ok: res.ok, status: res.status, data };
}

export default function DisputePage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<Step[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [citationFailures, setCitationFailures] = useState<{ id: string; reason: string; token?: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setDetail(body as Detail);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const run = detail?.run ?? null;
  const runStatus = liveStatus ?? run?.status ?? null;
  const active = runStatus === 'queued' || runStatus === 'running';

  // Live trace over SSE while the run is active.
  useEffect(() => {
    if (!run || !(run.status === 'queued' || run.status === 'running')) return;
    setLiveSteps([]);
    const es = new EventSource(`/api/disputes/${encodeURIComponent(id)}/stream?run=${encodeURIComponent(run.id)}`);
    es.addEventListener('step', (ev) => {
      try {
        const step = JSON.parse((ev as MessageEvent).data) as Step;
        setLiveSteps((prev) => (prev.some((p) => p.seq === step.seq) ? prev : [...prev, step]));
      } catch {
        /* malformed frame */
      }
    });
    es.addEventListener('status', (ev) => {
      try {
        setLiveStatus((JSON.parse((ev as MessageEvent).data) as { status: string }).status);
      } catch {
        /* malformed frame */
      }
    });
    es.addEventListener('done', () => {
      es.close();
      setLiveStatus(null);
      load();
    });
    es.onerror = () => {
      // EventSource reconnects on its own; refetch so the page never shows stale state.
      load();
    };
    return () => es.close();
  }, [id, run?.id, run?.status, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const steps = useMemo(() => {
    const map = new Map<number, Step>();
    for (const s of detail?.steps ?? []) map.set(s.seq, s);
    for (const s of liveSteps) map.set(s.seq, s);
    return [...map.values()].sort((a, b) => a.seq - b.seq);
  }, [detail?.steps, liveSteps]);

  const sourcesByKey = useMemo(() => new Map((detail?.sources ?? []).map((s) => [s.source_key, s])), [detail?.sources]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <h1 className="mb-2 text-xl font-semibold">Dispute {id} not found</h1>
        <p className="mb-6 text-sm text-ink-muted">It may not be synced yet. The poller checks PayPal every 30 seconds.</p>
        <Link href="/" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">
          Back to inbox
        </Link>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6">
        {error ? (
          <div role="alert" className="rounded-md border border-lost/30 bg-lost-soft px-4 py-3 text-sm text-lost">
            Couldn&apos;t load this dispute: {error}.{' '}
            <button type="button" className="font-medium underline" onClick={load}>
              Retry
            </button>
          </div>
        ) : (
          <div aria-busy="true">
            <div className="dd-skeleton mb-2 h-8 w-72" />
            <div className="dd-skeleton h-64 w-full" />
          </div>
        )}
      </div>
    );
  }

  const d = detail.dispute;
  const isFixture = d.source === 'fixture';
  const resolved = d.status === 'RESOLVED' || Boolean(d.outcome);
  const dueMs = d.seller_response_due_at ? Date.parse(d.seller_response_due_at) - now : null;
  const draftReadyMs = run?.draft_ready_at ? since(run.clock_started_at, run.draft_ready_at) : null;
  const submittedMs = run?.finished_at ? since(run.clock_started_at, run.finished_at) : null;
  const liveMs = run && active ? since(run.clock_started_at, now) : null;
  const sentences = run?.draft?.sentences ?? [];
  const removed = run?.draft?.removed ?? [];
  const canAct = !isFixture && !resolved && run?.status === 'draft_ready';
  const evOptions = run?.ev?.options ?? [];
  const offer = evOptions.find((o) => o.action === 'MAKE_OFFER');

  const startRun = async (force: boolean) => {
    setBusy('run');
    setOutcome(null);
    const r = await postJson(`/api/disputes/${encodeURIComponent(id)}/run`, { force });
    setBusy(null);
    if (!r.ok) setOutcome({ kind: 'err', title: r.data?.error?.message ?? `Run failed (${r.status})` });
    await load();
  };

  const approve = async () => {
    if (!run) return;
    setBusy('approve');
    setOutcome(null);
    setCitationFailures([]);
    const edited = Object.entries(edits)
      .filter(([sid, text]) => text.trim() && text.trim() !== sentences.find((s) => s.id === sid)?.text)
      .map(([sid, text]) => ({ id: sid, text: text.trim() }));
    const r = await postJson(`/api/disputes/${encodeURIComponent(id)}/approve`, {
      run_id: run.id,
      ...(edited.length ? { edited_sentences: edited } : {}),
    });
    setBusy(null);
    if (r.ok) {
      setOutcome({ kind: 'ok', title: 'Evidence submitted to PayPal', status_code: r.data.paypal?.status_code, debug_id: r.data.paypal?.debug_id, elapsed_ms: r.data.elapsed_ms });
      setEdits({});
    } else {
      if (r.data?.error?.code === 'CITATION_FAILED') setCitationFailures(r.data.error.failures ?? r.data.error.details?.failed ?? []);
      setOutcome({ kind: 'err', title: r.data?.error?.message ?? `Submission failed (${r.status})`, debug_id: r.data?.error?.debug_id });
    }
    await load();
  };

  const concede = async (action: 'accept_claim' | 'make_offer') => {
    if (!run) return;
    const fraction = 0.5;
    const offerCents = Math.round(d.amount_cents * fraction);
    const ok = window.confirm(
      action === 'accept_claim'
        ? `Accept the claim and refund ${money(d.amount_cents, d.currency)} in PayPal?`
        : `Offer the buyer a ${money(offerCents, d.currency)} partial refund in PayPal?`,
    );
    if (!ok) return;
    setBusy(action);
    setOutcome(null);
    const note =
      action === 'accept_claim'
        ? 'We are sorry this order did not work out. We have accepted the claim and issued a full refund.'
        : 'We are sorry this order did not work out. We would like to offer a partial refund to resolve this.';
    const r = await postJson(`/api/disputes/${encodeURIComponent(id)}/concede`, {
      run_id: run.id,
      action,
      note,
      ...(action === 'make_offer' ? { offer_amount_cents: offerCents, offer_type: 'REFUND' } : {}),
    });
    setBusy(null);
    setOutcome(
      r.ok
        ? { kind: 'ok', title: action === 'accept_claim' ? 'Claim accepted in PayPal' : 'Offer sent in PayPal', status_code: r.data.paypal?.status_code, debug_id: r.data.paypal?.debug_id }
        : { kind: 'err', title: r.data?.error?.message ?? `Request failed (${r.status})`, debug_id: r.data?.error?.debug_id },
    );
    await load();
  };

  const simulate = async (body: Record<string, string>) => {
    setBusy('simulate');
    const r = await postJson(`/api/disputes/${encodeURIComponent(id)}/simulate`, body);
    setBusy(null);
    setOutcome(
      r.ok
        ? { kind: 'ok', title: `Sandbox: dispute now ${r.data.dispute_status}`, status_code: r.data.paypal?.status_code, debug_id: r.data.paypal?.debug_id }
        : { kind: 'err', title: r.data?.error?.message ?? `Simulate failed (${r.status})`, debug_id: r.data?.error?.debug_id },
    );
    await load();
  };

  const openSrc = openSource ? sourcesByKey.get(openSource) : undefined;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6">
      <Link href="/" className="text-sm text-ink-muted hover:text-ink">
        ← Inbox
      </Link>

      {/* Header */}
      <div className="mb-6 mt-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold sm:text-2xl">{d.id}</h1>
            {isFixture && <span className="rounded-full bg-canvas px-2 py-0.5 text-xs font-medium text-ink-muted ring-1 ring-line">Fixture history</span>}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${resolved ? (d.outcome?.includes('SELLER') ? 'bg-won-soft text-won' : 'bg-lost-soft text-lost') : 'bg-accent-soft text-accent-ink'}`}>
              {d.outcome ?? d.status}
            </span>
          </div>
          <p className="mt-1 text-sm text-ink-muted">
            {REASON_LABEL[d.reason] ?? d.reason} · {money(d.amount_cents, d.currency)}
            {detail.sku ? ` · ${detail.sku.sku} ${detail.sku.name}` : ''}
            {detail.order?.buyer_name ? ` · ${detail.order.buyer_name}` : ''}
            {d.stage ? ` · ${d.stage}` : ''}
          </p>
          {detail.trigger_event && (
            <p className="mt-1 text-xs text-ink-faint">
              Triggered by{' '}
              {detail.trigger_event.source === 'demo_trigger'
                ? 'Demo trigger (not a PayPal webhook)'
                : detail.trigger_event.source === 'paypal'
                  ? `PayPal webhook ${detail.trigger_event.event_type}${detail.trigger_event.verified ? ' · signature verified' : ''}`
                  : 'poller / manual run'}
            </p>
          )}
        </div>
        {dueMs !== null && !resolved && (
          <div className={`rounded-md px-3 py-2 text-sm ${dueMs < 0 ? 'bg-lost-soft text-lost' : dueMs < 48 * 3600e3 ? 'bg-due-soon-soft text-due-soon' : 'bg-surface text-ink-muted ring-1 ring-line'}`}>
            {dueMs < 0 ? 'Response overdue' : `Response due in ${dueSpan(dueMs)}`}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-lost/30 bg-lost-soft px-4 py-2 text-sm text-lost">
          Refresh failed: {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {/* Stopwatch */}
          {run && (
            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Draft ready</p>
                <p className={`tabular mt-1 text-2xl font-semibold ${active ? 'dd-pulse' : ''}`}>
                  {draftReadyMs !== null ? duration(draftReadyMs) : liveMs !== null ? duration(liveMs) : '—'}
                </p>
                <p className="text-xs text-ink-faint">measured from event receipt</p>
              </div>
              <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">Submitted</p>
                <p className="tabular mt-1 text-2xl font-semibold">{submittedMs !== null ? duration(submittedMs) : '—'}</p>
                <p className="text-xs text-ink-faint">includes your approval time</p>
              </div>
            </section>
          )}

          {/* Trace */}
          <section className="rounded-[var(--radius-card)] border border-line bg-surface">
            <header className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">Agent trace</h2>
              {run && <span className="text-xs text-ink-faint">{run.model_agent}{run.review_applied ? ` · reviewed by ${run.model_review}` : ''}</span>}
            </header>
            {!run && (
              <div className="px-4 py-8 text-center text-sm text-ink-muted">
                No agent run yet.
                {!isFixture && !resolved && (
                  <div className="mt-3">
                    <button type="button" disabled={busy !== null} onClick={() => startRun(false)} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
                      Analyse this dispute
                    </button>
                  </div>
                )}
              </div>
            )}
            {run && steps.length === 0 && <p className="px-4 py-6 text-sm text-ink-muted">{active ? 'Starting…' : 'No steps recorded.'}</p>}
            {steps.length > 0 && (
              <ol className="max-h-[420px] overflow-y-auto px-4 py-2">
                {steps.map((s) => (
                  <li key={s.seq} className="flex gap-3 border-b border-line py-2 text-sm last:border-0">
                    <span className="tabular w-6 shrink-0 text-right text-xs text-ink-faint">{s.seq}</span>
                    <span
                      className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                        s.kind === 'error' ? 'bg-lost-soft text-lost' : s.kind === 'decision' ? 'bg-accent-soft text-accent-ink' : 'bg-canvas text-ink-muted'
                      }`}
                    >
                      {s.kind.replace('_', ' ')}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{s.label}</span>
                    {s.duration_ms !== null && <span className="tabular shrink-0 text-xs text-ink-faint">{s.duration_ms} ms</span>}
                  </li>
                ))}
              </ol>
            )}
            {run?.status === 'failed' && (
              <div className="border-t border-line bg-lost-soft px-4 py-3 text-sm text-lost">
                Run failed{run.error ? `: ${run.error}` : ''}.{' '}
                <button type="button" disabled={busy !== null} onClick={() => startRun(true)} className="font-medium underline">
                  Retry run
                </button>
              </div>
            )}
          </section>

          {/* Draft */}
          {sentences.length > 0 && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface">
              <header className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Draft response</h2>
                <span className="text-xs text-ink-faint">
                  every sentence cites a stored source{run?.citation_check?.rounds ? ` · ${run.citation_check.rounds} repair round(s)` : ''}
                </span>
              </header>
              <div className="space-y-3 px-4 py-4 text-sm leading-relaxed">
                {sentences.map((s) => {
                  const failure = citationFailures.find((f) => f.id === s.id);
                  return (
                    <div key={s.id} className={failure ? 'rounded-md bg-lost-soft p-2' : ''}>
                      {editing === s.id ? (
                        <textarea
                          className="w-full rounded-md border border-line p-2 text-sm"
                          rows={3}
                          value={edits[s.id] ?? s.text}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [s.id]: e.target.value }))}
                          onBlur={() => setEditing(null)}
                          autoFocus
                        />
                      ) : (
                        <p>
                          <span>{edits[s.id] ?? s.text}</span>{' '}
                          {s.source_ids.map((k) => (
                            <button
                              key={k}
                              type="button"
                              onClick={() => setOpenSource(k)}
                              className="mx-0.5 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent-ink hover:bg-accent hover:text-white"
                              title={sourcesByKey.get(k)?.title ?? k}
                            >
                              {k}
                            </button>
                          ))}
                          {canAct && (
                            <button type="button" onClick={() => setEditing(s.id)} className="ml-1 text-xs text-ink-faint hover:text-ink">
                              edit
                            </button>
                          )}
                        </p>
                      )}
                      {failure && (
                        <p className="mt-1 text-xs text-lost">
                          {failure.reason}
                          {failure.token ? `: "${failure.token}" is not in the cited sources` : ''}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {removed.length > 0 && (
                <details className="border-t border-line px-4 py-3 text-sm">
                  <summary className="cursor-pointer text-ink-muted">{removed.length} sentence(s) removed, unsupported</summary>
                  <ul className="mt-2 space-y-2">
                    {removed.map((r) => (
                      <li key={r.id} className="text-ink-faint">
                        <span className="line-through">{r.text}</span> <span className="font-mono text-xs">({r.reason})</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          )}

          {/* PDF */}
          {run?.draft && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface">
              <header className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="text-sm font-semibold">Evidence packet</h2>
                <a href={`/api/disputes/${encodeURIComponent(id)}/pdf?run=${run.id}`} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent hover:underline">
                  Open PDF
                </a>
              </header>
              <iframe title="Evidence packet preview" src={`/api/disputes/${encodeURIComponent(id)}/pdf?run=${run.id}`} className="hidden h-[520px] w-full sm:block" />
              <p className="px-4 py-3 text-xs text-ink-faint sm:hidden">Tap “Open PDF” to view the exact file that will be submitted.</p>
            </section>
          )}
        </div>

        {/* Decision column */}
        <aside className="space-y-4">
          {run?.strength && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-semibold">Evidence strength</h2>
                <span className="tabular text-2xl font-semibold">{run.strength.score}</span>
              </div>
              <div className="mb-3 h-2 overflow-hidden rounded-full bg-canvas">
                <div className="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, run.strength.score))}%` }} />
              </div>
              <ul className="space-y-1.5 text-sm">
                {run.strength.items.map((it) => (
                  <li key={it.key} className="flex items-start gap-2">
                    <span className={it.present ? 'text-won' : 'text-ink-faint'} aria-label={it.present ? 'present' : 'missing'}>
                      {it.present ? '✓' : '○'}
                    </span>
                    <span className="flex-1">
                      {it.label}
                      {it.source_ids.map((k) => (
                        <button key={k} type="button" onClick={() => setOpenSource(k)} className="ml-1 font-mono text-[11px] text-accent hover:underline">
                          {k}
                        </button>
                      ))}
                    </span>
                    <span className="tabular text-xs text-ink-faint">{it.present ? it.weight : 0}/{it.weight}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-ink-faint">Published rubric per reason code. Not a trained model.</p>
            </section>
          )}

          {run?.ev && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-4">
              <h2 className="mb-1 text-sm font-semibold">Fight or concede</h2>
              <p className="mb-3 text-xs text-ink-faint">s = strength used as a rough win proxy, not a trained probability.</p>
              <ul className="space-y-2">
                {evOptions.map((o) => (
                  <li key={o.action} className={`rounded-md border px-3 py-2 ${o.action === run.ev?.recommended ? 'border-accent bg-accent-soft/40' : 'border-line'}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">
                        {o.action.replace('_', ' ').toLowerCase()}
                        {o.action === run.ev?.recommended && <span className="ml-2 text-xs text-accent-ink">recommended</span>}
                      </span>
                      <span className="tabular">{money(o.expected_cost_cents, d.currency)}</span>
                    </div>
                    <p className="mt-1 break-words font-mono text-[11px] text-ink-muted">{o.formula}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {run && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-4">
              <h2 className="mb-3 text-sm font-semibold">Decision</h2>
              {isFixture && <p className="text-sm text-ink-muted">Fixture history is read-only. Nothing can be sent to PayPal.</p>}
              {!isFixture && resolved && <p className="text-sm text-ink-muted">This dispute is resolved{d.outcome ? `: ${d.outcome}` : ''}.</p>}
              {!isFixture && !resolved && run.status !== 'draft_ready' && (
                <p className="text-sm text-ink-muted">
                  {active ? 'Waiting for the draft…' : run.status === 'submitted' ? 'Evidence submitted.' : run.status === 'conceded' ? 'Conceded.' : 'No draft to approve.'}
                </p>
              )}
              {canAct && (
                <div className="space-y-2">
                  <button type="button" onClick={approve} disabled={busy !== null || sentences.length === 0} className="w-full rounded-md bg-accent px-4 py-3 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-60">
                    {busy === 'approve' ? 'Submitting…' : 'Approve & submit evidence'}
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" onClick={() => concede('accept_claim')} disabled={busy !== null} className="rounded-md border border-line px-3 py-2 text-sm font-medium hover:bg-canvas disabled:opacity-60">
                      {busy === 'accept_claim' ? 'Sending…' : 'Accept & refund'}
                    </button>
                    <button type="button" onClick={() => concede('make_offer')} disabled={busy !== null} className="rounded-md border border-line px-3 py-2 text-sm font-medium hover:bg-canvas disabled:opacity-60">
                      {busy === 'make_offer' ? 'Sending…' : offer ? 'Offer 50%' : 'Make offer'}
                    </button>
                  </div>
                  <p className="text-xs text-ink-faint">Nothing is sent to PayPal until you press one of these.</p>
                </div>
              )}
              {!isFixture && !active && run.status !== 'failed' && (
                <button type="button" onClick={() => startRun(true)} disabled={busy !== null} className="mt-3 text-xs text-ink-muted underline hover:text-ink">
                  Re-run analysis
                </button>
              )}
            </section>
          )}

          {outcome && (
            <section
              role="status"
              className={`rounded-[var(--radius-card)] border px-4 py-3 text-sm ${outcome.kind === 'ok' ? 'border-won/30 bg-won-soft text-won' : 'border-lost/30 bg-lost-soft text-lost'}`}
            >
              <p className="font-semibold">{outcome.title}</p>
              {(outcome.status_code || outcome.debug_id) && (
                <p className="mt-1 font-mono text-xs">
                  {outcome.status_code ? `HTTP ${outcome.status_code}` : ''}
                  {outcome.debug_id ? ` · debug_id ${outcome.debug_id}` : ''}
                </p>
              )}
              {typeof outcome.elapsed_ms === 'number' && <p className="mt-1 text-xs">Claim to submission: {duration(outcome.elapsed_ms)} (measured)</p>}
            </section>
          )}

          {!isFixture && (
            <section className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-4 py-4">
              <h2 className="mb-1 text-sm font-semibold">Sandbox controls</h2>
              <p className="mb-3 text-xs text-ink-faint">Sandbox-only PayPal endpoints to move the dispute along on camera.</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-1">
                <button type="button" disabled={busy !== null} onClick={() => simulate({ action: 'require_evidence', evidence_for: 'SELLER_EVIDENCE' })} className="rounded-md border border-line px-3 py-2 text-xs font-medium hover:bg-canvas disabled:opacity-60">
                  Require seller evidence
                </button>
                <button type="button" disabled={busy !== null} onClick={() => simulate({ action: 'adjudicate', outcome: 'SELLER_FAVOR' })} className="rounded-md border border-line px-3 py-2 text-xs font-medium hover:bg-canvas disabled:opacity-60">
                  Adjudicate: seller wins
                </button>
                <button type="button" disabled={busy !== null} onClick={() => simulate({ action: 'adjudicate', outcome: 'BUYER_FAVOR' })} className="rounded-md border border-line px-3 py-2 text-xs font-medium hover:bg-canvas disabled:opacity-60">
                  Adjudicate: buyer wins
                </button>
              </div>
            </section>
          )}

          {detail.paypal_calls.length > 0 && (
            <section className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-4">
              <h2 className="mb-2 text-sm font-semibold">PayPal calls</h2>
              <ul className="space-y-1 font-mono text-[11px]">
                {detail.paypal_calls.slice(0, 12).map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span className="truncate">
                      {c.method} {c.path}
                    </span>
                    <span className={c.status_code && c.status_code < 300 ? 'text-won' : 'text-lost'}>{c.status_code ?? 'ERR'}</span>
                  </li>
                ))}
              </ul>
              <Link href={`/activity`} className="mt-2 inline-block text-xs text-accent hover:underline">
                All calls with debug_id →
              </Link>
            </section>
          )}
        </aside>
      </div>

      {/* Source drawer */}
      {openSource && (
        <div className="fixed inset-0 z-50 flex justify-end bg-ink/30" onClick={() => setOpenSource(null)} role="dialog" aria-modal="true" aria-label={`Source ${openSource}`}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <span className="rounded bg-accent-soft px-2 py-0.5 font-mono text-xs font-semibold text-accent-ink">{openSource}</span>
              <button type="button" onClick={() => setOpenSource(null)} className="text-sm text-ink-muted hover:text-ink">
                Close
              </button>
            </div>
            {openSrc ? (
              <>
                <h3 className="mb-1 font-semibold">{openSrc.title}</h3>
                <p className="mb-3 text-xs text-ink-faint">
                  {openSrc.kind.replace('_', ' ')} · fetched {openSrc.fetched_at.replace('T', ' ').slice(0, 19)} UTC
                  {openSrc.ref ? ` · ${openSrc.ref}` : ''}
                </p>
                <pre className="whitespace-pre-wrap break-words rounded-md bg-canvas p-3 font-mono text-xs">{openSrc.content}</pre>
              </>
            ) : (
              <p className="text-sm text-ink-muted">This source is not in this run.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}