'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { EmptyState } from '@/components/EmptyState';
import { ErrorBanner } from '@/components/ErrorBanner';
import { SkeletonCard } from '@/components/Skeleton';
import { FixtureBadge } from '@/components/SandboxBadge';

interface PatternQuote {
  dispute_id: string;
  message_ref: string;
  quote: string;
}

interface PatternRow {
  id: string;
  sku: string | null;
  reason: string;
  theme: string;
  dispute_count: number;
  matching_count: number;
  quotes_json?: string;
  quotes?: PatternQuote[];
  headline: string;
  action: string;
  includes_fixture: number | boolean;
  computed_at: string;
}

const REASON_SHORT: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'INR',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'SNAD',
  UNAUTHORISED: 'Unauthorised',
};

function quotesOf(p: PatternRow): PatternQuote[] {
  if (Array.isArray(p.quotes)) return p.quotes;
  if (!p.quotes_json) return [];
  try {
    const parsed = JSON.parse(p.quotes_json) as unknown;
    return Array.isArray(parsed) ? (parsed as PatternQuote[]) : [];
  } catch {
    return [];
  }
}

export default function PatternsPage() {
  const [patterns, setPatterns] = useState<PatternRow[] | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/patterns', { cache: 'no-store' });
      const json = (await res.json().catch(() => ({}))) as {
        patterns?: PatternRow[];
        computed_at?: string | null;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      setPatterns(json.patterns ?? []);
      setComputedAt(json.computed_at ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load patterns.');
      setPatterns((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const recompute = async () => {
    setRecomputing(true);
    setError(null);
    try {
      const res = await fetch('/api/patterns/recompute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json().catch(() => ({}))) as { patterns?: PatternRow[]; error?: { message?: string } };
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
      setPatterns(json.patterns ?? []);
      setComputedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recompute failed.');
    } finally {
      setRecomputing(false);
    }
  };

  const sorted = [...(patterns ?? [])].sort(
    (a, b) => b.matching_count / Math.max(1, b.dispute_count) - a.matching_count / Math.max(1, a.dispute_count) || b.matching_count - a.matching_count,
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Patterns</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Root causes across disputes, grouped by SKU and reason. Claude tags each buyer message with a theme from a closed
            list; the counts and quotes below are computed by code, and every quote is checked word-for-word against its message.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {computedAt ? <span className="text-xs text-slate-500">Computed {new Date(computedAt).toLocaleString()}</span> : null}
          <button
            type="button"
            onClick={recompute}
            disabled={recomputing}
            className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
          >
            {recomputing ? 'Recomputing…' : 'Recompute'}
          </button>
        </div>
      </div>

      {error ? <ErrorBanner title="Patterns unavailable" message={error} onRetry={() => void load()} /> : null}

      {patterns === null ? (
        <div className="grid gap-4 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No patterns yet"
          description="Patterns appear once there are at least two disputes on the same SKU and reason. Load fixture history with npm run setup, then recompute."
          action={
            <button
              type="button"
              onClick={recompute}
              disabled={recomputing}
              className="rounded-md bg-teal-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
            >
              Recompute now
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {sorted.map((p) => {
            const quotes = quotesOf(p);
            const ratio = p.dispute_count > 0 ? p.matching_count / p.dispute_count : 0;
            return (
              <article key={p.id} className="flex flex-col rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {p.sku ? <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700">{p.sku}</span> : null}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">{REASON_SHORT[p.reason] ?? p.reason}</span>
                  <span className="rounded bg-teal-50 px-1.5 py-0.5 text-teal-800">{p.theme.replace(/_/g, ' ')}</span>
                  {p.includes_fixture ? <FixtureBadge /> : null}
                </div>
                <h2 className="mt-2 text-base font-semibold text-slate-900">{p.headline}</h2>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={clsx('h-full rounded-full', ratio >= 0.5 ? 'bg-amber-500' : 'bg-teal-600')}
                      style={{ width: `${Math.round(ratio * 100)}%` }}
                    />
                  </div>
                  <span className="font-mono text-xs tabular-nums text-slate-600">
                    {p.matching_count} of {p.dispute_count}
                  </span>
                </div>
                <div className="mt-3 rounded-md border border-teal-200 bg-teal-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-800">Prevention action</p>
                  <p className="mt-0.5 text-sm text-slate-900">{p.action}</p>
                </div>
                {quotes.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {quotes.slice(0, 4).map((q, i) => (
                      <li key={`${q.dispute_id}-${q.message_ref}-${i}`} className="border-l-2 border-slate-200 pl-3">
                        <blockquote className="text-sm italic text-slate-700">&ldquo;{q.quote}&rdquo;</blockquote>
                        <Link
                          href={`/disputes/${encodeURIComponent(q.dispute_id)}`}
                          className="font-mono text-[11px] text-slate-500 hover:text-teal-700"
                        >
                          {q.dispute_id} · {q.message_ref}
                        </Link>
                      </li>
                    ))}
                    {quotes.length > 4 ? <li className="text-xs text-slate-500">+{quotes.length - 4} more quotes</li> : null}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}