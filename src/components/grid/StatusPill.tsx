'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import clsx from 'clsx';
import type { GridRow } from './DisputeGrid';

type Tone = 'amber' | 'red' | 'green' | 'teal' | 'neutral';

export function statusDisplay(
  status: string | null | undefined,
  outcome?: string | null,
  runStatus?: string | null,
): { label: string; tone: Tone } {
  if (status === 'RESOLVED') {
    if (outcome && /SELLER_FAVOU?R/.test(outcome)) return { label: 'Won', tone: 'green' };
    if (outcome && /BUYER_FAVOU?R/.test(outcome)) return { label: 'Lost', tone: 'red' };
    return { label: 'Resolved', tone: 'neutral' };
  }
  if (runStatus === 'submitted') return { label: 'Evidence submitted', tone: 'green' };
  if (runStatus === 'conceded') return { label: 'Conceded', tone: 'neutral' };
  switch (status) {
    case 'WAITING_FOR_SELLER_RESPONSE':
      return { label: 'Needs response', tone: 'amber' };
    case 'UNDER_REVIEW':
      return { label: 'Under review', tone: 'teal' };
    case 'OPEN':
      return { label: 'Open', tone: 'neutral' };
    case 'WAITING_FOR_BUYER_RESPONSE':
      return { label: 'Waiting on buyer', tone: 'neutral' };
    case null:
    case undefined:
    case '':
      return { label: 'Unknown', tone: 'neutral' };
    default:
      return {
        label: status
          .toLowerCase()
          .split('_')
          .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
          .join(' '),
        tone: 'neutral',
      };
  }
}

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  status?: string | null;
  outcome?: string | null;
  runStatus?: string | null;
};

export default function StatusPill(props: Props) {
  if (props.node?.rowPinned) return null;
  const data = props.data;
  const status = props.status ?? (typeof props.value === 'string' ? props.value : data?.status ?? null);
  const runStatus = props.runStatus ?? data?.latest_run?.status ?? null;
  const { label, tone } = statusDisplay(status, props.outcome ?? data?.outcome ?? null, runStatus);

  const pill = (
    <span
      title={status ?? undefined}
      className={clsx(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        tone === 'amber' && 'border-amber-200 bg-amber-50 text-amber-800',
        tone === 'red' && 'border-red-200 bg-red-50 text-red-700',
        tone === 'green' && 'border-green-200 bg-green-50 text-green-700',
        tone === 'teal' && 'border-teal-200 bg-teal-50 text-teal-800',
        tone === 'neutral' && 'border-stone-200 bg-stone-50 text-stone-700',
      )}
    >
      {label}
    </span>
  );

  if (props.node) return <div className="flex h-full items-center">{pill}</div>;
  return pill;
}

export { StatusPill };