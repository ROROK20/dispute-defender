'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import clsx from 'clsx';
import type { GridRow } from './DisputeGrid';

const LABELS: Record<string, string> = {
  FIGHT: 'Fight',
  ACCEPT_CLAIM: 'Accept claim',
  MAKE_OFFER: 'Make offer',
};

export function recommendationLabel(rec: string | null | undefined): string {
  if (!rec) return '—';
  return LABELS[rec] ?? rec;
}

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  recommendation?: string | null;
  runStatus?: string | null;
};

export default function RecommendationCell(props: Props) {
  if (props.node?.rowPinned) return null;
  const rec =
    props.recommendation ?? (typeof props.value === 'string' ? props.value : props.data?.recommendation ?? null);
  const runStatus = props.runStatus ?? props.data?.latest_run?.status ?? null;

  let content: React.ReactNode;
  if (runStatus === 'queued' || runStatus === 'running') {
    content = (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-800">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-700" />
        Analyzing…
      </span>
    );
  } else if (runStatus === 'failed' && !rec) {
    content = <span className="text-xs font-medium text-red-700">Run failed</span>;
  } else if (!rec) {
    content = <span className="text-xs text-stone-400">—</span>;
  } else {
    content = (
      <span
        className={clsx(
          'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold',
          rec === 'FIGHT' ? 'bg-teal-700 text-white' : 'border border-stone-300 bg-white text-stone-800',
        )}
        title="Lowest expected cost from the expected-value arithmetic"
      >
        {recommendationLabel(rec)}
      </span>
    );
  }

  return <div className="flex h-full items-center">{content}</div>;
}

export { RecommendationCell };