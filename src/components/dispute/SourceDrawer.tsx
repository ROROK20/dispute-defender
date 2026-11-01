'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';

export interface SourceData {
  source_key: string;
  kind: string;
  title: string;
  content: string;
  ref?: string | null;
  fetched_at?: string | null;
}

export interface SourceDrawerProps {
  sources: SourceData[];
  activeKey: string | null;
  onClose: () => void;
  onSelect?: (key: string) => void;
}

const KIND_LABEL: Record<string, string> = {
  dispute_field: 'Dispute',
  order_field: 'Order',
  capture_field: 'Capture',
  tracking_event: 'Tracking',
  buyer_message: 'Buyer message',
  seller_message: 'Seller message',
  policy_clause: 'Policy',
  sku_field: 'Listing',
};

function keyNum(k: string): number {
  const n = Number(k.replace(/^S/, ''));
  return Number.isFinite(n) ? n : 0;
}

export function SourceDrawer({ sources, activeKey, onClose, onSelect }: SourceDrawerProps) {
  const open = activeKey !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  const active = sources.find((s) => s.source_key === activeKey) ?? null;
  const sorted = [...sources].sort((a, b) => keyNum(a.source_key) - keyNum(b.source_key));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panelRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Source ${activeKey}`}>
      <button type="button" aria-label="Close source" className="absolute inset-0 bg-slate-900/30" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative mt-auto flex max-h-[85vh] w-full flex-col rounded-t-xl bg-white shadow-xl outline-none sm:mt-0 sm:h-full sm:max-h-none sm:w-[28rem] sm:rounded-none"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="rounded bg-teal-700 px-1.5 font-mono text-xs font-semibold text-white">{activeKey}</span>
              {active ? <span className="text-xs text-slate-500">{KIND_LABEL[active.kind] ?? active.kind}</span> : null}
            </div>
            <h2 className="mt-1 break-words text-sm font-semibold text-slate-900">{active?.title ?? 'Unknown source'}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {active ? (
            <>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Exact stored text</p>
              <pre className="whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-800">
                {active.content}
              </pre>
              <dl className="mt-3 space-y-1 text-xs text-slate-600">
                {active.ref ? (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-slate-400">Reference</dt>
                    <dd className="break-all font-mono">{active.ref}</dd>
                  </div>
                ) : null}
                {active.fetched_at ? (
                  <div className="flex gap-2">
                    <dt className="w-20 shrink-0 text-slate-400">Fetched</dt>
                    <dd className="font-mono">{active.fetched_at}</dd>
                  </div>
                ) : null}
              </dl>
              {active.title.toLowerCase().includes('carrier fixture') ? (
                <p className="mt-3 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                  This tracking event comes from the carrier fixture provider, not a live carrier API.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-red-700">This run has no source with key {activeKey}.</p>
          )}
        </div>
        {sorted.length > 1 && onSelect ? (
          <nav className="flex flex-wrap gap-1 border-t border-slate-200 px-4 py-2" aria-label="All sources">
            {sorted.map((s) => (
              <button
                key={s.source_key}
                type="button"
                onClick={() => onSelect(s.source_key)}
                title={s.title}
                className={clsx(
                  'rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold',
                  s.source_key === activeKey ? 'bg-teal-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200',
                )}
              >
                {s.source_key}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
    </div>
  );
}

export default SourceDrawer;