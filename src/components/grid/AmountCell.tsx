'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import type { GridRow } from './DisputeGrid';

export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  cents?: number | null;
  currency?: string;
};

export default function AmountCell(props: Props) {
  const data = props.data;
  const cents = props.cents ?? (typeof props.value === 'number' ? props.value : data?.amount_cents ?? null);
  const currency = props.currency ?? data?.currency ?? 'USD';

  if (props.node?.rowPinned) {
    return (
      <div className="flex h-full flex-col justify-center leading-tight">
        <span className="font-semibold tabular-nums text-stone-900">{formatCents(cents, currency)}</span>
        <span className="text-[11px] text-stone-500">$ at risk</span>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-end">
      <span className="font-medium tabular-nums text-stone-900">{formatCents(cents, currency)}</span>
    </div>
  );
}

export { AmountCell };