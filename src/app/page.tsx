'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import DisputeGrid from '@/components/grid/DisputeGrid';
import TriggerDemoButton from '@/components/TriggerDemoButton';

type LatestRun = { id: string; status: string; draft_ready_ms: number | null; submitted_ms: number | null } | null;

type DisputeRow = {
  id: string;
  source: 'paypal_sandbox' | 'fixture';
  reason: string;
  status: string;
  stage: string | null;
  amount_cents: number;
  currency: string;
  sku: string | null;
  sku_name: string | null;
  buyer_name: string | null;
  seller_response_due_at: string | null;
  strength_score: number | null;
  recommendation: string | null;
  latest_run: LatestRun;
};

function money(cents: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export default function InboxPage() {
  const [disputes, setDisputes] = useState<DisputeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/disputes', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setDisputes(body.disputes as DisputeRow[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const res = await fetch('/api/disputes/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setSyncNote(`Synced ${body.synced} dispute(s)${body.new_runs?.length ? `, started ${body.new_runs.length} run(s)` : ''}.`);
      await load();
    } catch (e) {
      setSyncNote(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSyncing(false);
    }
  };

  const stats = useMemo(() => {
    const open = (disputes ?? []).filter((d) => !['RESOLVED', 'CLOSED'].includes(d.status));
    const atRisk = open.reduce((sum, d) => sum + d.amount_cents, 0);
    const now = Date.now();
    const dueSoon = open.filter((d) => {
      if (!d.seller_response_due_at) return false;
      const ms = new Date(d.seller_response_due_at).getTime() - now;
      return ms > 0 && ms < 48 * 3600 * 1000;
    }).length;
    return { open: open.length, atRisk, dueSoon };
  }, [disputes]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dispute inbox</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Juniper Thread Co. · every draft is cited, nothing goes to PayPal until you approve it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-canvas disabled:opacity-60"
          >
            {syncing ? 'Syncing…' : 'Sync from PayPal'}
          </button>
          <TriggerDemoButton />
        </div>
      </div>

      {syncNote && <p className="mb-4 text-sm text-ink-muted" role="status">{syncNote}</p>}

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Open disputes" value={disputes ? String(stats.open) : '—'} />
        <Stat label="$ at risk" value={disputes ? money(stats.atRisk) : '—'} />
        <Stat label="Due in < 48 h" value={disputes ? String(stats.dueSoon) : '—'} tone={stats.dueSoon > 0 ? 'amber' : undefined} />
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-lost/30 bg-lost-soft px-4 py-3 text-sm text-lost">
          Couldn&apos;t load disputes: {error}.{' '}
          <button type="button" onClick={load} className="font-medium underline">
            Retry
          </button>
        </div>
      )}

      {disputes === null && !error && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="dd-skeleton mb-3 h-8 w-full last:mb-0" />
          ))}
        </div>
      )}

      {disputes !== null && disputes.length === 0 && (
        <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-6 py-14 text-center">
          <h2 className="mb-2 text-lg font-semibold">No disputes yet</h2>
          <p className="mx-auto mb-5 max-w-md text-sm text-ink-muted">
            Disputes arrive by PayPal webhook or the 30-second poller. Open one from a sandbox buyer account
            (see docs/sandbox-staging.md), or use a staged dispute from the demo pool.
          </p>
          <div className="flex justify-center">
            <TriggerDemoButton />
          </div>
        </div>
      )}

      {disputes !== null && disputes.length > 0 && <DisputeGrid disputes={disputes} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'amber' }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`tabular mt-1 text-xl font-semibold ${tone === 'amber' ? 'text-due-soon' : ''}`}>{value}</p>
    </div>
  );
}