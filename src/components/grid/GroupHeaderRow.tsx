'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import { formatCents } from './AmountCell';
import type { GridRow } from './DisputeGrid';

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  label?: string;
  count?: number;
  totalCents?: number;
  dueSoon?: number;
};

export default function GroupHeaderRow(props: Props) {
  const data = props.data;
  const label = props.label ?? data?.groupLabel ?? 'Group';
  const count = props.count ?? data?.groupCount ?? 0;
  const totalCents = props.totalCents ?? data?.groupTotalCents ?? 0;
  const dueSoon = props.dueSoon ?? data?.groupDueSoon ?? 0;

  return (
    <div className="flex h-full items-center justify-between gap-3 border-y border-stone-200 bg-stone-50 px-4 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="h-4 w-1 rounded-full bg-teal-700" />
        <span className="truncate font-semibold text-stone-900">{label}</span>
        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-stone-600 ring-1 ring-stone-200">
          {count} {count === 1 ? 'dispute' : 'disputes'}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-4 text-xs text-stone-600">
        {dueSoon > 0 && <span className="font-medium text-amber-700">{dueSoon} due in &lt; 48 h</span>}
        <span className="tabular-nums">
          <span className="font-semibold text-stone-900">{formatCents(totalCents)}</span> disputed
        </span>
      </div>
    </div>
  );
}

export { GroupHeaderRow };