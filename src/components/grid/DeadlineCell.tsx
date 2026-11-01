'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import clsx from 'clsx';
import { useNow } from '../../hooks/useNow';
import type { GridRow } from './DisputeGrid';

export type DeadlineTone = 'neutral' | 'amber' | 'red' | 'muted';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function span(ms: number): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 0)}m`;
}

export function deadlineInfo(
  dueIso: string | null | undefined,
  status: string | null | undefined,
  now: number,
): { label: string; tone: DeadlineTone; title: string; msLeft: number | null } {
  if (status === 'RESOLVED') return { label: 'Closed', tone: 'muted', title: 'Dispute resolved', msLeft: null };
  if (!dueIso) return { label: '—', tone: 'muted', title: 'No seller response due date', msLeft: null };
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return { label: '—', tone: 'muted', title: 'Unreadable due date', msLeft: null };
  const msLeft = due - now;
  const title = `Seller response due ${new Date(due).toLocaleString()}`;
  if (msLeft <= 0) return { label: `Overdue ${span(msLeft)}`, tone: 'red', title, msLeft };
  if (msLeft < 2 * DAY) return { label: `${span(msLeft)} left`, tone: 'amber', title, msLeft };
  return { label: `${span(msLeft)} left`, tone: 'neutral', title, msLeft };
}

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  dueAt?: string | null;
  status?: string | null;
};

export default function DeadlineCell(props: Props) {
  const now = useNow(30_000);
  const data = props.data;

  if (props.node?.rowPinned) {
    const n = data?.dueSoonCount ?? 0;
    return (
      <div className="flex h-full flex-col justify-center leading-tight">
        <span className={clsx('font-semibold tabular-nums', n > 0 ? 'text-amber-700' : 'text-stone-900')}>{n}</span>
        <span className="text-[11px] text-stone-500">due in &lt; 48 h</span>
      </div>
    );
  }

  const dueAt = props.dueAt ?? (typeof props.value === 'string' ? props.value : data?.seller_response_due_at ?? null);
  const status = props.status ?? data?.status ?? null;
  const info = deadlineInfo(dueAt, status, now);

  return (
    <div className="flex h-full items-center" title={info.title}>
      <span
        className={clsx(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium tabular-nums',
          info.tone === 'red' && 'bg-red-50 text-red-700',
          info.tone === 'amber' && 'bg-amber-50 text-amber-800',
          info.tone === 'neutral' && 'text-stone-700',
          info.tone === 'muted' && 'text-stone-400',
        )}
      >
        {(info.tone === 'red' || info.tone === 'amber') && (
          <span
            aria-hidden
            className={clsx('h-1.5 w-1.5 rounded-full', info.tone === 'red' ? 'bg-red-600' : 'bg-amber-500')}
          />
        )}
        {info.label}
      </span>
    </div>
  );
}

export { DeadlineCell };