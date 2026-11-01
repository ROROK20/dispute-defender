'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

export interface StopwatchProps {
  clockStartedAt?: string | null;
  draftReadyAt?: string | null;
  finishedAt?: string | null;
  status?: string | null;
  className?: string;
}

function toMs(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  const totalSeconds = safe / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

export function Stopwatch({ clockStartedAt, draftReadyAt, finishedAt, status, className }: StopwatchProps) {
  const start = toMs(clockStartedAt);
  const draft = toMs(draftReadyAt);
  const finish = toMs(finishedAt);
  const draftRunning = start !== null && draft === null && (status === 'queued' || status === 'running');
  const submitRunning = start !== null && finish === null && (status === 'queued' || status === 'running' || status === 'draft_ready');
  const ticking = draftRunning || submitRunning;

  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [ticking]);

  const draftValue = start === null ? null : draft !== null ? draft - start : draftRunning ? now - start : null;
  const submitValue = start === null ? null : finish !== null ? finish - start : submitRunning ? now - start : null;

  return (
    <div className={clsx('grid grid-cols-2 gap-3', className)} aria-label="Measured elapsed times">
      <Readout
        label="Draft ready"
        sub="from event received"
        value={draftValue}
        running={draftRunning}
        done={draft !== null}
      />
      <Readout
        label="Submitted"
        sub="includes your approval time"
        value={submitValue}
        running={submitRunning}
        done={finish !== null}
      />
      {start === null ? (
        <p className="col-span-2 text-xs text-slate-500">The clock starts when the trigger event is received.</p>
      ) : null}
    </div>
  );
}

function Readout({
  label,
  sub,
  value,
  running,
  done,
}: {
  label: string;
  sub: string;
  value: number | null;
  running: boolean;
  done: boolean;
}) {
  return (
    <div
      className={clsx(
        'rounded-lg border px-3 py-2',
        done ? 'border-green-200 bg-green-50' : running ? 'border-teal-200 bg-teal-50' : 'border-slate-200 bg-white',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        {running ? <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-600" /> : null}
        {label}
      </div>
      <div
        className={clsx(
          'font-mono text-2xl font-semibold tabular-nums',
          done ? 'text-green-800' : running ? 'text-teal-800' : 'text-slate-400',
        )}
        aria-live={done ? 'polite' : 'off'}
      >
        {value === null ? '--:--.-' : formatElapsed(value)}
      </div>
      <div className="text-[11px] text-slate-500">{sub}</div>
    </div>
  );
}

export default Stopwatch;