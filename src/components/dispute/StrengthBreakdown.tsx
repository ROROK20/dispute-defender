'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { CitationChip } from './CitationChip';

export interface StrengthItem {
  key: string;
  label: string;
  weight: number;
  present: boolean;
  source_ids: string[];
}

export interface StrengthData {
  score: number;
  items: StrengthItem[];
}

export interface StrengthBreakdownProps {
  strength: StrengthData | string | null | undefined;
  onSourceClick?: (key: string) => void;
  defaultOpen?: boolean;
  className?: string;
}

export function parseStrength(v: StrengthData | string | null | undefined): StrengthData | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as StrengthData;
      return typeof parsed.score === 'number' && Array.isArray(parsed.items) ? parsed : null;
    } catch {
      return null;
    }
  }
  return v;
}

export function StrengthBreakdown({ strength, onSourceClick, defaultOpen = false, className }: StrengthBreakdownProps) {
  const data = useMemo(() => parseStrength(strength), [strength]);
  const [open, setOpen] = useState(defaultOpen);

  if (!data) {
    return (
      <section className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)}>
        <h2 className="text-sm font-semibold text-slate-900">Evidence strength</h2>
        <p className="mt-1 text-sm text-slate-500">Scored once the agent has gathered sources.</p>
      </section>
    );
  }

  const score = Math.max(0, Math.min(100, Math.round(data.score)));
  const tone = score >= 70 ? 'bg-green-600' : score >= 40 ? 'bg-amber-500' : 'bg-red-600';

  return (
    <section
      className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)}
      onMouseEnter={() => setOpen(true)}
      aria-label="Evidence strength"
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Evidence strength</h2>
        <span className="font-mono text-xl font-semibold tabular-nums text-slate-900">
          {score}
          <span className="text-sm text-slate-400">/100</span>
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score}>
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${score}%` }} />
      </div>
      <p className="mt-1.5 text-[11px] text-slate-500">
        Deterministic rubric score from evidence present. Not a trained win probability.
      </p>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="mt-2 text-xs font-medium text-teal-700 hover:text-teal-900"
      >
        {open ? 'Hide breakdown' : 'Show breakdown'}
      </button>
      {open ? (
        <ul className="mt-2 divide-y divide-slate-100">
          {data.items.map((item) => (
            <li key={item.key} className="flex items-start gap-2 py-1.5">
              <span
                aria-label={item.present ? 'present' : 'missing'}
                className={clsx(
                  'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white',
                  item.present ? 'bg-green-600' : 'bg-slate-300',
                )}
              >
                {item.present ? '✓' : '–'}
              </span>
              <div className="min-w-0 flex-1">
                <span className={clsx('text-sm', item.present ? 'text-slate-800' : 'text-slate-500')}>{item.label}</span>
                {item.source_ids.length > 0 ? (
                  <span className="ml-1">
                    {item.source_ids.map((k) => (
                      <CitationChip key={k} sourceKey={k} onClick={onSourceClick} />
                    ))}
                  </span>
                ) : null}
              </div>
              <span className={clsx('shrink-0 font-mono text-xs tabular-nums', item.present ? 'text-green-700' : 'text-slate-400')}>
                {item.present ? `+${item.weight}` : `0/${item.weight}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export default StrengthBreakdown;