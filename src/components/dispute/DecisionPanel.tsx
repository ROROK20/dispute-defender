'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { SubmissionResult, type SubmissionResultProps } from './SubmissionResult';
import { parseEv, type EvData } from './ExpectedValueMath';

export interface DecisionPanelProps {
  disputeId: string;
  runId: string | null;
  runStatus?: string | null;
  disputeStatus: string;
  source: string;
  amountCents: number;
  currency: string;
  recommendation?: string | null;
  ev?: EvData | string | null;
  editedSentences?: { id: string; text: string }[];
  hasDraft?: boolean;
  onDone?: () => void;
  className?: string;
}

type Mode = 'idle' | 'accept_claim' | 'make_offer' | 'message';

interface ApiError {
  error?: { code?: string; message?: string; debug_id?: string };
}

const OFFER_TYPES = [
  { value: 'REFUND', label: 'Partial refund, buyer keeps item' },
  { value: 'REFUND_WITH_RETURN', label: 'Refund with return' },
  { value: 'REFUND_WITH_REPLACEMENT', label: 'Refund with replacement' },
] as const;

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> & ApiError }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> & ApiError;
  return { status: res.status, json };
}

export function DecisionPanel({
  disputeId,
  runId,
  runStatus,
  disputeStatus,
  source,
  amountCents,
  currency,
  recommendation,
  ev,
  editedSentences = [],
  hasDraft = true,
  onDone,
  className,
}: DecisionPanelProps) {
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [offerDollars, setOfferDollars] = useState(() => ((amountCents * 0.5) / 100).toFixed(2));
  const [offerType, setOfferType] = useState<(typeof OFFER_TYPES)[number]['value']>('REFUND');
  const [result, setResult] = useState<SubmissionResultProps | null>(null);

  const evData = useMemo(() => parseEv(ev ?? null), [ev]);
  const costOf = (action: string) => evData?.options.find((o) => o.action.toUpperCase() === action)?.expected_cost_cents;
  const rec = (recommendation ?? evData?.recommended ?? '').toUpperCase();

  const isFixture = source === 'fixture';
  const finished = runStatus === 'submitted' || runStatus === 'conceded';
  const waiting = disputeStatus === 'WAITING_FOR_SELLER_RESPONSE';
  const blockedReason = isFixture
    ? 'Fixture history is read-only and never sent to PayPal.'
    : finished
      ? 'A decision for this run was already sent to PayPal.'
      : !waiting
        ? `PayPal status is ${disputeStatus.replace(/_/g, ' ').toLowerCase()}, so a seller response is not accepted right now.`
        : !runId
          ? 'Start an agent run first.'
          : null;
  const approveBlocked = blockedReason ?? (runStatus !== 'draft_ready' || !hasDraft ? 'Waiting for the draft to be ready.' : null);

  const fail = (action: string, status: number, json: ApiError) =>
    setResult({
      action,
      ok: false,
      statusCode: status,
      debugId: json.error?.debug_id ?? null,
      message:
        json.error?.code === 'CITATION_FAILED'
          ? `An edited sentence no longer matches its sources: ${json.error?.message ?? ''}`.trim()
          : (json.error?.message ?? `Request failed (HTTP ${status}).`),
    });

  const succeed = (action: string, json: Record<string, unknown>) => {
    const paypal = (json.paypal ?? {}) as { status_code?: number; debug_id?: string };
    setResult({
      action,
      ok: true,
      statusCode: paypal.status_code ?? null,
      debugId: paypal.debug_id ?? null,
      elapsedMs: typeof json.elapsed_ms === 'number' ? json.elapsed_ms : null,
      decisionId: typeof json.decision_id === 'string' ? json.decision_id : null,
    });
    setMode('idle');
    onDone?.();
  };

  const guarded = async (fn: () => Promise<void>, action: string) => {
    setBusy(true);
    setResult(null);
    try {
      await fn();
    } catch (err) {
      setResult({ action, ok: false, message: err instanceof Error ? err.message : 'Network error.' });
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    guarded(async () => {
      const { status, json } = await postJson(`/api/disputes/${encodeURIComponent(disputeId)}/approve`, {
        run_id: runId,
        ...(editedSentences.length > 0 ? { edited_sentences: editedSentences } : {}),
      });
      if (status >= 200 && status < 300) succeed('submit_evidence', json);
      else fail('submit_evidence', status, json);
    }, 'submit_evidence');

  const concede = (action: 'accept_claim' | 'make_offer') =>
    guarded(async () => {
      const trimmed = note.trim();
      if (!trimmed) {
        setResult({ action, ok: false, message: 'Add a short note for the buyer.' });
        return;
      }
      const body: Record<string, unknown> = { run_id: runId, action, note: trimmed };
      if (action === 'make_offer') {
        const cents = Math.round(Number(offerDollars) * 100);
        if (!Number.isFinite(cents) || cents <= 0 || cents > amountCents) {
          setResult({ action, ok: false, message: `Offer must be between ${money(1, currency)} and ${money(amountCents, currency)}.` });
          return;
        }
        body.offer_amount_cents = cents;
        body.offer_type = offerType;
      }
      const { status, json } = await postJson(`/api/disputes/${encodeURIComponent(disputeId)}/concede`, body);
      if (status >= 200 && status < 300) succeed(action, json);
      else fail(action, status, json);
    }, action);

  const sendMessage = () =>
    guarded(async () => {
      const trimmed = message.trim();
      if (!trimmed || trimmed.length > 2000) {
        setResult({ action: 'send_message', ok: false, message: 'Message must be 1–2000 characters.' });
        return;
      }
      const { status, json } = await postJson(`/api/disputes/${encodeURIComponent(disputeId)}/message`, { message: trimmed });
      if (status >= 200 && status < 300) {
        setMessage('');
        succeed('send_message', json);
      } else fail('send_message', status, json);
    }, 'send_message');

  const fightCost = costOf('FIGHT');
  const acceptCost = costOf('ACCEPT_CLAIM');
  const offerCost = costOf('MAKE_OFFER');

  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)} aria-label="Decision">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Your decision</h2>
        {rec ? (
          <span className="text-xs text-slate-600">
            Agent recommends <span className="font-semibold text-teal-800">{rec.replace(/_/g, ' ').toLowerCase()}</span>
          </span>
        ) : null}
      </div>
      <p className="mt-0.5 text-xs text-slate-500">Nothing is sent to PayPal until you press a button below.</p>

      {blockedReason ? <p className="mt-3 rounded-md bg-slate-100 p-2 text-xs text-slate-700">{blockedReason}</p> : null}

      <div className="mt-3 flex flex-col gap-2">
        <button
          type="button"
          onClick={approve}
          disabled={busy || approveBlocked !== null}
          title={approveBlocked ?? undefined}
          className={clsx(
            'flex items-center justify-between gap-2 rounded-md px-4 py-3 text-left text-base font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50',
            rec === 'FIGHT' || !rec ? 'bg-teal-700 hover:bg-teal-800' : 'bg-slate-700 hover:bg-slate-800',
          )}
        >
          <span>{busy && mode === 'idle' ? 'Submitting to PayPal…' : 'Approve & submit evidence'}</span>
          {typeof fightCost === 'number' ? (
            <span className="font-mono text-xs font-normal opacity-90">exp. cost {money(fightCost, currency)}</span>
          ) : null}
        </button>
        {editedSentences.length > 0 ? (
          <p className="text-xs text-amber-700">
            {editedSentences.length} edited sentence{editedSentences.length === 1 ? '' : 's'} will be re-checked against sources first.
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode(mode === 'accept_claim' ? 'idle' : 'accept_claim')}
            disabled={busy || blockedReason !== null}
            className={clsx(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
              rec === 'ACCEPT_CLAIM' ? 'border-teal-400 bg-teal-50 text-teal-900' : 'border-slate-300 text-slate-800 hover:bg-slate-50',
            )}
          >
            Accept & refund
            {typeof acceptCost === 'number' ? (
              <span className="font-mono text-xs font-normal text-slate-500">exp. cost {money(acceptCost, currency)}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setMode(mode === 'make_offer' ? 'idle' : 'make_offer')}
            disabled={busy || blockedReason !== null}
            className={clsx(
              'flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50',
              rec === 'MAKE_OFFER' ? 'border-teal-400 bg-teal-50 text-teal-900' : 'border-slate-300 text-slate-800 hover:bg-slate-50',
            )}
          >
            Make an offer
            {typeof offerCost === 'number' ? (
              <span className="font-mono text-xs font-normal text-slate-500">exp. cost {money(offerCost, currency)}</span>
            ) : null}
          </button>
        </div>
      </div>

      {mode === 'accept_claim' || mode === 'make_offer' ? (
        <div className="mt-3 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
          {mode === 'make_offer' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="text-xs text-slate-600">
                Offer amount ({currency})
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  max={(amountCents / 100).toFixed(2)}
                  value={offerDollars}
                  onChange={(e) => setOfferDollars(e.target.value)}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </label>
              <label className="text-xs text-slate-600">
                Offer type
                <select
                  value={offerType}
                  onChange={(e) => setOfferType(e.target.value as (typeof OFFER_TYPES)[number]['value'])}
                  className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
                >
                  {OFFER_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="text-xs text-slate-600">
              PayPal refunds the buyer {money(amountCents, currency)} and closes the dispute.
            </p>
          )}
          <label className="block text-xs text-slate-600">
            Note to buyer
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={2000}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
              placeholder="Thanks for letting us know. We're sorry the order didn't work out."
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode('idle')} className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-900">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => concede(mode)}
              disabled={busy}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60"
            >
              {busy ? 'Sending…' : mode === 'accept_claim' ? 'Confirm refund' : 'Send offer'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-3 border-t border-slate-100 pt-3">
        <button
          type="button"
          onClick={() => setMode(mode === 'message' ? 'idle' : 'message')}
          disabled={isFixture}
          className="text-xs font-medium text-teal-700 hover:text-teal-900 disabled:text-slate-400"
        >
          {mode === 'message' ? 'Hide message' : 'Message the buyer'}
        </button>
        {mode === 'message' ? (
          <div className="mt-2 space-y-2">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600"
              aria-label="Message to buyer"
            />
            <div className="flex items-center justify-between">
              <span className="text-[11px] tabular-nums text-slate-400">{message.length}/2000</span>
              <button
                type="button"
                onClick={sendMessage}
                disabled={busy || message.trim().length === 0}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
              >
                {busy ? 'Sending…' : 'Send message'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {result ? <SubmissionResult {...result} className="mt-3" /> : null}
    </section>
  );
}

export default DecisionPanel;