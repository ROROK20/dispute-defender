'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

type Call = {
  id: number;
  dispute_id: string | null;
  run_id: string | null;
  method: string;
  path: string;
  status_code: number | null;
  debug_id: string | null;
  duration_ms: number | null;
  error_name: string | null;
  error_message: string | null;
  created_at: string;
};

export default function ActivityPage() {
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const q = filter.trim() ? `?dispute_id=${encodeURIComponent(filter.trim())}` : '';
      const res = await fetch(`/api/paypal-calls${q}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      setCalls(body.calls as Call[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:py-8">
      <h1 className="text-2xl font-semibold tracking-tight">PayPal activity</h1>
      <p className="mb-5 mt-1 text-sm text-ink-muted">
        Every call this app made to PayPal, with its <code className="font-mono">paypal-debug-id</code>.
      </p>

      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by dispute id (PP-D-…)"
        className="mb-4 w-full max-w-sm rounded-md border border-line bg-surface px-3 py-2 text-sm"
        aria-label="Filter by dispute id"
      />

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-lost/30 bg-lost-soft px-4 py-3 text-sm text-lost">
          Couldn&apos;t load activity: {error}
        </div>
      )}

      {calls === null && !error && (
        <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4" aria-busy="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="dd-skeleton mb-3 h-6 w-full last:mb-0" />
          ))}
        </div>
      )}

      {calls !== null && calls.length === 0 && (
        <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-6 py-12 text-center text-sm text-ink-muted">
          No PayPal calls recorded yet. Calls appear here as soon as the poller, a webhook or the storefront talks to PayPal.
        </div>
      )}

      {calls !== null && calls.length > 0 && (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-ink-faint">
              <tr>
                <th className="px-3 py-2">Time (UTC)</th>
                <th className="px-3 py-2">Call</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">debug_id</th>
                <th className="px-3 py-2">Dispute</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const ok = c.status_code !== null && c.status_code >= 200 && c.status_code < 300;
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 align-top">
                    <td className="tabular whitespace-nowrap px-3 py-2 text-ink-muted">{c.created_at.replace('T', ' ').slice(0, 19)}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      <span className="font-semibold">{c.method}</span> {c.path}
                      {c.error_message && (
                        <div className="mt-1 font-sans text-xs text-lost">
                          {c.error_name ? `${c.error_name}: ` : ''}
                          {c.error_message}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          ok ? 'bg-won-soft text-won' : 'bg-lost-soft text-lost'
                        }`}
                      >
                        {c.status_code ?? 'ERR'}
                      </span>
                    </td>
                    <td className="tabular px-3 py-2 text-ink-muted">{c.duration_ms ?? '—'} ms</td>
                    <td className="px-3 py-2 font-mono text-xs">{c.debug_id ?? '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {c.dispute_id ? (
                        <Link href={`/disputes/${encodeURIComponent(c.dispute_id)}`} className="text-accent hover:underline">
                          {c.dispute_id}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}