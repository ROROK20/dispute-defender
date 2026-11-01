'use client';

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { formatDistanceStrict } from 'date-fns';
import { FixtureBadge } from '../SandboxBadge';

export interface DisputeHeaderData {
  id: string;
  source: string;
  reason: string;
  status: string;
  stage?: string | null;
  outcome?: string | null;
  amount_cents: number;
  currency: string;
  sku?: string | null;
  seller_response_due_at?: string | null;
  pp_created_at?: string | null;
}

export interface DisputeHeaderProps {
  dispute: DisputeHeaderData;
  skuName?: string | null;
  buyerName?: string | null;
  actions?: ReactNode;
}

export const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Not as described',
  UNAUTHORISED: 'Unauthorised',
};

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function statusTone(status: string, outcome?: string | null): string {
  if (outcome?.includes('SELLER')) return 'bg-green-50 text-green-800 ring-green-200';
  if (outcome?.includes('BUYER')) return 'bg-red-50 text-red-800 ring-red-200';
  if (status === 'WAITING_FOR_SELLER_RESPONSE') return 'bg-amber-50 text-amber-800 ring-amber-200';
  return 'bg-slate-100 text-slate-700 ring-slate-200';
}

export function DisputeHeader({ dispute, skuName, buyerName, actions }: DisputeHeaderProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const due = dispute.seller_response_due_at ? new Date(dispute.seller_response_due_at).getTime() : null;
  const dueValid = due !== null && !Number.isNaN(due);
  const msLeft = dueValid ? due - now : null;
  const waiting = dispute.status === 'WAITING_FOR_SELLER_RESPONSE';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <Link href="/" className="text-xs text-slate-500 hover:text-teal-700">
          ← Inbox
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-lg font-semibold text-slate-900">{dispute.id}</h1>
          <span className={clsx('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', statusTone(dispute.status, dispute.outcome))}>
            {(dispute.outcome ?? dispute.status).replace(/_/g, ' ').toLowerCase()}
          </span>
          {dispute.stage ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{dispute.stage.toLowerCase()}</span>
          ) : null}
          {dispute.source === 'fixture' ? <FixtureBadge /> : null}
        </div>
        <p className="mt-1 text-sm text-slate-600">
          <span className="font-medium text-slate-900">{REASON_LABELS[dispute.reason] ?? dispute.reason}</span>
          {' · '}
          <span className="tabular-nums">{money(dispute.amount_cents, dispute.currency)}</span>
          {dispute.sku ? (
            <>
              {' · '}
              <span className="font-mono">{dispute.sku}</span>
              {skuName ? ` ${skuName}` : ''}
            </>
          ) : null}
          {buyerName ? ` · buyer ${buyerName}` : ''}
        </p>
      </div>
      <div className="flex flex-col items-start gap-2 sm:items-end">
        {dueValid && msLeft !== null ? (
          <div
            className={clsx(
              'rounded-md px-3 py-1.5 text-sm font-medium',
              !waiting
                ? 'bg-slate-100 text-slate-600'
                : msLeft < 0
                  ? 'bg-red-50 text-red-700'
                  : msLeft < 48 * 3_600_000
                    ? 'bg-amber-50 text-amber-800'
                    : 'bg-slate-100 text-slate-700',
            )}
            title={new Date(due).toISOString()}
          >
            {msLeft < 0
              ? `Response overdue by ${formatDistanceStrict(due, now)}`
              : `Response due in ${formatDistanceStrict(due, now)}`}
          </div>
        ) : null}
        {actions}
      </div>
    </div>
  );
}

export default DisputeHeader;