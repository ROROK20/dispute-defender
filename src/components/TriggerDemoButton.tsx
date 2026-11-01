'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import clsx from 'clsx';

interface TriggerResponse {
  run_id?: string;
  dispute_id?: string;
  event_id?: string;
  error?: { code?: string; message?: string };
}

interface PoolResponse {
  available?: number;
}

export interface TriggerDemoButtonProps {
  compact?: boolean;
  onTriggered?: (result: { run_id: string; dispute_id: string; event_id: string }) => void;
}

export function TriggerDemoButton({ compact = false, onTriggered }: TriggerDemoButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [available, setAvailable] = useState<number | null>(null);

  const loadPool = useCallback(async () => {
    try {
      const res = await fetch('/api/demo/pool', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as PoolResponse;
      if (typeof json.available === 'number') setAvailable(json.available);
    } catch {
      setAvailable(null);
    }
  }, []);

  useEffect(() => {
    void loadPool();
  }, [loadPool]);

  const trigger = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/demo/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const json = (await res.json().catch(() => ({}))) as TriggerResponse;
      if (res.status === 202 && json.run_id && json.dispute_id && json.event_id) {
        onTriggered?.({ run_id: json.run_id, dispute_id: json.dispute_id, event_id: json.event_id });
        router.push(`/disputes/${encodeURIComponent(json.dispute_id)}?run=${encodeURIComponent(json.run_id)}`);
        return;
      }
      if (res.status === 409) {
        setMessage({
          tone: 'info',
          text:
            json.error?.message ??
            'The staged dispute pool is empty. Open a new dispute in the sandbox Resolution Center (docs/sandbox-staging.md).',
        });
      } else if (res.status === 429) {
        setMessage({ tone: 'info', text: json.error?.message ?? 'Rate limited. Try again in a minute.' });
      } else {
        setMessage({ tone: 'error', text: json.error?.message ?? `Trigger failed (HTTP ${res.status}).` });
      }
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof Error ? err.message : 'Network error.' });
    } finally {
      setBusy(false);
      void loadPool();
    }
  };

  return (
    <div className={clsx('relative flex flex-col items-end', !compact && 'gap-2')}>
      <button
        type="button"
        onClick={trigger}
        disabled={busy}
        title="Takes the oldest real staged sandbox dispute and starts an agent run. This is a demo trigger, not a PayPal webhook."
        className={clsx(
          'inline-flex items-center gap-2 rounded-md bg-teal-700 font-medium text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-wait disabled:opacity-70',
          compact ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-base',
        )}
      >
        {busy ? (
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        ) : null}
        Trigger demo dispute
        {available !== null ? (
          <span className="rounded bg-white/20 px-1.5 text-xs tabular-nums" aria-label={`${available} staged disputes available`}>
            {available}
          </span>
        ) : null}
      </button>
      {message ? (
        <p
          role="status"
          className={clsx(
            'max-w-xs text-right text-xs',
            compact && 'absolute right-0 top-full z-40 mt-2 rounded-md border bg-white p-2 shadow-md',
            message.tone === 'error' ? 'border-red-200 text-red-700' : 'border-slate-200 text-slate-700',
          )}
        >
          {message.text}
          {compact ? (
            <button type="button" className="ml-2 text-slate-400 hover:text-slate-700" onClick={() => setMessage(null)} aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export default TriggerDemoButton;