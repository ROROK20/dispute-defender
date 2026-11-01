'use client';

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Skeleton } from '../Skeleton';
import { ErrorBanner } from '../ErrorBanner';

export interface PdfPreviewProps {
  disputeId: string;
  runId: string | null;
  disabled?: boolean;
  className?: string;
}

export function PdfPreview({ disputeId, runId, disabled = false, className }: PdfPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; debugId?: string } | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      if (!runId || disabled) return null;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/disputes/${encodeURIComponent(disputeId)}/pdf?run=${encodeURIComponent(runId)}`, {
          cache: 'no-store',
          signal,
        });
        if (!res.ok) {
          const json = (await res.json().catch(() => null)) as { error?: { message?: string; debug_id?: string } } | null;
          throw Object.assign(new Error(json?.error?.message ?? `PDF failed (HTTP ${res.status})`), {
            debugId: json?.error?.debug_id,
          });
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        setSize(blob.size);
        setUrl(objectUrl);
        return objectUrl;
      } catch (err) {
        if (signal.aborted) return null;
        const e = err as Error & { debugId?: string };
        setError({ message: e.message || 'Could not build the evidence packet.', debugId: e.debugId });
        return null;
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [disputeId, runId, disabled],
  );

  useEffect(() => {
    const controller = new AbortController();
    let created: string | null = null;
    void load(controller.signal).then((u) => {
      created = u;
    });
    return () => {
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [load, nonce]);

  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);

  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white', className)} aria-label="Evidence packet preview">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Evidence packet</h2>
          {size !== null ? (
            <span className={clsx('font-mono text-xs tabular-nums', size > 500 * 1024 ? 'text-amber-700' : 'text-slate-500')}>
              {(size / 1024).toFixed(0)} KB
            </span>
          ) : null}
        </div>
        {url ? (
          <div className="flex gap-3 text-xs font-medium">
            <a href={url} target="_blank" rel="noreferrer" className="text-teal-700 hover:text-teal-900">
              Open
            </a>
            <a href={url} download={`evidence-${disputeId}.pdf`} className="text-teal-700 hover:text-teal-900">
              Download
            </a>
          </div>
        ) : null}
      </header>
      <div className="p-3">
        {!runId || disabled ? (
          <p className="px-1 py-6 text-center text-sm text-slate-500">The PDF is built from the approved draft once the agent finishes.</p>
        ) : error ? (
          <ErrorBanner title="PDF unavailable" message={error.message} debugId={error.debugId} onRetry={() => setNonce((n) => n + 1)} />
        ) : loading || !url ? (
          <Skeleton className="h-[28rem] w-full" />
        ) : (
          <>
            <iframe title={`Evidence packet for ${disputeId}`} src={url} className="hidden h-[32rem] w-full rounded border border-slate-200 sm:block" />
            <p className="text-sm text-slate-600 sm:hidden">
              PDF ready. Tap <span className="font-medium">Open</span> to view the exact bytes that will be submitted.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

export default PdfPreview;