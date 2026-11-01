'use client';

import { useState } from 'react';
import clsx from 'clsx';

export interface SandboxControlsProps {
  disputeId: string;
  paypalEnv?: string;
  isFixture?: boolean;
  onChanged?: (disputeStatus: string | null) => void;
  className?: string;
}

type SimBody =
  | { action: 'require_evidence'; evidence_for: 'SELLER_EVIDENCE' | 'BUYER_EVIDENCE' }
  | { action: 'adjudicate'; outcome: 'SELLER_FAVOR' | 'BUYER_FAVOR' };

interface SimResult {
  ok: boolean;
  label: string;
  statusCode?: number;
  debugId?: string;
  disputeStatus?: string | null;
  message?: string;
}

const CONTROLS: { label: string; body: SimBody }[] = [
  { label: 'Require seller evidence', body: { action: 'require_evidence', evidence_for: 'SELLER_EVIDENCE' } },
  { label: 'Require buyer evidence', body: { action: 'require_evidence', evidence_for: 'BUYER_EVIDENCE' } },
  { label: 'Adjudicate: seller wins', body: { action: 'adjudicate', outcome: 'SELLER_FAVOR' } },
  { label: 'Adjudicate: buyer wins', body: { action: 'adjudicate', outcome: 'BUYER_FAVOR' } },
];

export function SandboxControls({ disputeId, paypalEnv = 'sandbox', isFixture = false, onChanged, className }: SandboxControlsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SimResult | null>(null);

  if (paypalEnv !== 'sandbox') return null;

  const run = async (label: string, body: SimBody) => {
    setBusy(label);
    setResult(null);
    try {
      const res = await fetch(`/api/disputes/${encodeURIComponent(disputeId)}/simulate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as {
        paypal?: { status_code?: number; debug_id?: string };
        dispute_status?: string | null;
        error?: { message?: string; debug_id?: string };
      };
      if (!res.ok) {
        setResult({
          ok: false,
          label,
          statusCode: res.status,
          debugId: json.error?.debug_id,
          message: json.error?.message ?? `HTTP ${res.status}`,
        });
        return;
      }
      setResult({
        ok: true,
        label,
        statusCode: json.paypal?.status_code,
        debugId: json.paypal?.debug_id,
        disputeStatus: json.dispute_status ?? null,
      });
      onChanged?.(json.dispute_status ?? null);
    } catch (err) {
      setResult({ ok: false, label, message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={clsx('rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4', className)} aria-label="Sandbox lifecycle controls">
      <h2 className="text-sm font-semibold text-slate-900">Sandbox lifecycle</h2>
      <p className="mt-0.5 text-xs text-slate-500">
        Sandbox-only PayPal endpoints that move this dispute to the next state. Not available on live.
      </p>
      {isFixture ? (
        <p className="mt-2 text-xs text-slate-600">Fixture history disputes are read-only.</p>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CONTROLS.map((c) => (
            <button
              key={c.label}
              type="button"
              disabled={busy !== null}
              onClick={() => run(c.label, c.body)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
            >
              {busy === c.label ? 'Calling PayPal…' : c.label}
            </button>
          ))}
        </div>
      )}
      {result ? (
        <div
          role="status"
          className={clsx('mt-3 rounded-md p-2 font-mono text-xs', result.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800')}
        >
          <div className="font-sans font-medium">
            {result.label}: {result.ok ? 'done' : 'failed'}
          </div>
          {typeof result.statusCode === 'number' ? <div>HTTP {result.statusCode}</div> : null}
          {result.debugId ? <div className="break-all">paypal-debug-id {result.debugId}</div> : null}
          {result.disputeStatus ? <div>dispute status {result.disputeStatus}</div> : null}
          {result.message ? <div className="font-sans">{result.message}</div> : null}
        </div>
      ) : null}
    </section>
  );
}

export default SandboxControls;