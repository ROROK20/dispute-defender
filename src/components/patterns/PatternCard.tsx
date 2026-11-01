'use client';

import Link from 'next/link';
import clsx from 'clsx';
import { reasonLabel, reasonShort } from '../grid/ReasonCell';

export type PatternQuote = {
  dispute_id: string;
  message_ref: string;
  quote: string;
};

export type Pattern = {
  id: string;
  sku: string | null;
  reason: string;
  theme: string;
  dispute_count: number;
  matching_count: number;
  quotes?: PatternQuote[];
  quotes_json?: string;
  headline: string;
  action: string;
  includes_fixture: number | boolean;
  computed_at: string;
};

export function parseQuotes(p: Pattern): PatternQuote[] {
  if (Array.isArray(p.quotes)) return p.quotes;
  if (typeof p.quotes_json === 'string' && p.quotes_json.length > 0) {
    try {
      const parsed: unknown = JSON.parse(p.quotes_json);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (q): q is PatternQuote =>
            !!q && typeof q === 'object' && typeof (q as PatternQuote).quote === 'string' && typeof (q as PatternQuote).dispute_id === 'string',
        );
      }
    } catch {
      return [];
    }
  }
  return [];
}

export function themeLabel(theme: string): string {
  const t = theme.replace(/_/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

type Props = {
  pattern: Pattern;
  className?: string;
  maxQuotes?: number;
};

export default function PatternCard({ pattern, className, maxQuotes = 3 }: Props) {
  const quotes = parseQuotes(pattern);
  const total = Math.max(pattern.dispute_count, 0);
  const matching = Math.max(Math.min(pattern.matching_count, total), 0);
  const pct = total > 0 ? Math.round((matching / total) * 100) : 0;
  const includesFixture = Boolean(pattern.includes_fixture);
  const computed = Date.parse(pattern.computed_at);

  return (
    <article className={clsx('flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm', className)}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono font-semibold text-stone-600" title={reasonLabel(pattern.reason)}>
            {reasonShort(pattern.reason)}
          </span>
          {pattern.sku && <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-stone-700">{pattern.sku}</span>}
          <span className="rounded-full bg-teal-50 px-2 py-0.5 font-medium text-teal-800">{themeLabel(pattern.theme)}</span>
          {includesFixture && (
            <span className="rounded bg-stone-100 px-1.5 py-0.5 font-medium text-stone-600 ring-1 ring-stone-200">
              Includes fixture history
            </span>
          )}
        </div>
        <h3 className="text-base font-semibold leading-snug text-stone-900">{pattern.headline}</h3>
      </header>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs text-stone-600">
          <span>
            <span className="font-semibold tabular-nums text-stone-900">{matching}</span> of{' '}
            <span className="tabular-nums">{total}</span> disputes in this group
          </span>
          <span className="tabular-nums">{pct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-stone-200" aria-hidden>
          <div className="h-full rounded-full bg-teal-700" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-[11px] text-stone-500">Counted by code from tagged buyer messages, not estimated by the model.</p>
      </div>

      <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-800">Prevention action</p>
        <p className="mt-1 text-sm text-stone-900">{pattern.action}</p>
      </div>

      {quotes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {quotes.slice(0, maxQuotes).map((q, i) => (
            <li key={`${q.dispute_id}-${q.message_ref}-${i}`} className="border-l-2 border-stone-300 pl-3">
              <blockquote className="text-sm italic text-stone-700">“{q.quote}”</blockquote>
              <Link
                href={`/disputes/${encodeURIComponent(q.dispute_id)}`}
                className="mt-0.5 inline-block font-mono text-[11px] text-teal-700 hover:underline"
              >
                {q.dispute_id} · {q.message_ref}
              </Link>
            </li>
          ))}
          {quotes.length > maxQuotes && (
            <li className="text-xs text-stone-500">+{quotes.length - maxQuotes} more verbatim quotes</li>
          )}
        </ul>
      ) : (
        <p className="text-xs text-stone-500">No verbatim quotes stored for this pattern.</p>
      )}

      {Number.isFinite(computed) && (
        <footer className="text-[11px] text-stone-400">Computed {new Date(computed).toLocaleString()}</footer>
      )}
    </article>
  );
}

export { PatternCard };