'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import type { GridRow } from './DisputeGrid';

const REASONS: Record<string, { label: string; short: string }> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: { label: 'Item not received', short: 'INR' },
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: { label: 'Not as described', short: 'SNAD' },
  UNAUTHORISED: { label: 'Unauthorised payment', short: 'UNAUTH' },
  UNAUTHORIZED: { label: 'Unauthorised payment', short: 'UNAUTH' },
  CREDIT_NOT_PROCESSED: { label: 'Credit not processed', short: 'CNP' },
  DUPLICATE_TRANSACTION: { label: 'Duplicate transaction', short: 'DUP' },
  INCORRECT_AMOUNT: { label: 'Incorrect amount', short: 'AMT' },
  PAYMENT_BY_OTHER_MEANS: { label: 'Paid by other means', short: 'OTHER' },
  CANCELED_RECURRING_BILLING: { label: 'Canceled recurring billing', short: 'RECUR' },
  PROBLEM_WITH_REMITTANCE: { label: 'Remittance problem', short: 'REMIT' },
  OTHER: { label: 'Other', short: 'OTHER' },
};

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return 'Unknown reason';
  return REASONS[reason]?.label ?? reason.replace(/_/g, ' ').toLowerCase();
}

export function reasonShort(reason: string | null | undefined): string {
  if (!reason) return '?';
  return REASONS[reason]?.short ?? reason.slice(0, 6);
}

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  reason?: string | null;
  stage?: string | null;
};

export default function ReasonCell(props: Props) {
  if (props.node?.rowPinned) return null;
  const reason = props.reason ?? (typeof props.value === 'string' ? props.value : props.data?.reason ?? null);
  const stage = props.stage ?? props.data?.stage ?? null;

  return (
    <div className="flex h-full min-w-0 items-center gap-2" title={reason ?? undefined}>
      <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-stone-600">
        {reasonShort(reason)}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm text-stone-900">{reasonLabel(reason)}</span>
        {stage && <span className="truncate text-[11px] uppercase tracking-wide text-stone-500">{stage.replace(/_/g, ' ')}</span>}
      </span>
    </div>
  );
}

export { ReasonCell };