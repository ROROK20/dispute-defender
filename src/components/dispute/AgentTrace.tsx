'use client';

import { useEffect, useRef } from 'react';
import clsx from 'clsx';
import { TraceStep, type TraceStepData } from './TraceStep';
import { SkeletonText } from '../Skeleton';

export type { TraceStepData } from './TraceStep';

export interface AgentTraceProps {
  steps: TraceStepData[];
  status?: string | null;
  connected?: boolean;
  error?: string | null;
  onSourceClick?: (key: string) => void;
  activeSourceKey?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  draft_ready: 'Draft ready',
  failed: 'Failed',
  submitted: 'Submitted',
  conceded: 'Conceded',
};

export function AgentTrace({
  steps,
  status,
  connected,
  error,
  onSourceClick,
  activeSourceKey,
  onRetry,
  retrying = false,
  className,
}: AgentTraceProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const live = status === 'queued' || status === 'running';
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);

  useEffect(() => {
    if (!live) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [sorted.length, live]);

  return (
    <section className={clsx('flex flex-col rounded-lg border border-slate-200 bg-white', className)} aria-label="Agent trace">
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold text-slate-900">Agent trace</h2>
        <div className="flex items-center gap-2 text-xs">
          {connected !== undefined && live ? (
            <span className={clsx('inline-flex items-center gap-1', connected ? 'text-teal-700' : 'text-slate-400')}>
              <span
                aria-hidden
                className={clsx('h-1.5 w-1.5 rounded-full', connected ? 'animate-pulse bg-teal-600' : 'bg-slate-300')}
              />
              {connected ? 'Live' : 'Reconnecting'}
            </span>
          ) : null}
          {status ? (
            <span
              className={clsx(
                'rounded-full px-2 py-0.5 font-medium',
                status === 'failed'
                  ? 'bg-red-50 text-red-700'
                  : status === 'submitted' || status === 'draft_ready'
                    ? 'bg-green-50 text-green-700'
                    : 'bg-slate-100 text-slate-700',
              )}
            >
              {STATUS_LABEL[status] ?? status}
            </span>
          ) : null}
          <span className="tabular-nums text-slate-400">{sorted.length} steps</span>
        </div>
      </header>
      <div ref={listRef} className="max-h-[32rem] overflow-y-auto px-4 py-3">
        {sorted.length === 0 ? (
          live ? (
            <div>
              <p className="mb-3 text-sm text-slate-500">Waiting for the first step…</p>
              <SkeletonText lines={3} />
            </div>
          ) : (
            <p className="text-sm text-slate-500">No agent run yet for this dispute.</p>
          )
        ) : (
          <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-[4px] before:top-1 before:w-px before:bg-slate-200">
            {sorted.map((step) => (
              <TraceStep key={step.seq} step={step} onSourceClick={onSourceClick} activeSourceKey={activeSourceKey} />
            ))}
          </ol>
        )}
        {live && sorted.length > 0 ? (
          <p className="mt-3 flex items-center gap-2 pl-6 text-xs text-slate-500">
            <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
            Working…
          </p>
        ) : null}
      </div>
      {error || status === 'failed' ? (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-red-100 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          <span className="min-w-0 break-words">{error ?? 'The run failed. The error step is shown above.'}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="rounded-md border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-60"
            >
              {retrying ? 'Starting…' : 'Retry run'}
            </button>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}

export default AgentTrace;