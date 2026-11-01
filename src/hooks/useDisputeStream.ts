'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';

export type StepKind = 'info' | 'tool_call' | 'tool_result' | 'check' | 'decision' | 'review' | 'error';

export type RunStatus = 'queued' | 'running' | 'draft_ready' | 'failed' | 'submitted' | 'conceded';

export type StreamStep = {
  seq: number;
  kind: StepKind;
  label: string;
  payload: unknown;
  duration_ms: number | null;
  created_at: string;
};

export type DisputeStreamState = {
  steps: StreamStep[];
  status: RunStatus | null;
  draftReadyAt: string | null;
  finishedAt: string | null;
  connected: boolean;
  done: boolean;
  error: string | null;
};

type Action =
  | { type: 'reset'; steps: StreamStep[] }
  | { type: 'open' }
  | { type: 'step'; step: StreamStep }
  | { type: 'status'; status: RunStatus; draftReadyAt?: string | null; finishedAt?: string | null }
  | { type: 'done' }
  | { type: 'disconnected' }
  | { type: 'error'; message: string };

const initialState: DisputeStreamState = {
  steps: [],
  status: null,
  draftReadyAt: null,
  finishedAt: null,
  connected: false,
  done: false,
  error: null,
};

function sortSteps(steps: StreamStep[]): StreamStep[] {
  return [...steps].sort((a, b) => a.seq - b.seq);
}

function reducer(state: DisputeStreamState, action: Action): DisputeStreamState {
  switch (action.type) {
    case 'reset':
      return { ...initialState, steps: sortSteps(action.steps) };
    case 'open':
      return { ...state, connected: true, error: null };
    case 'step': {
      // The server replays the stored backlog on every (re)connect; dedupe by seq.
      if (state.steps.some((s) => s.seq === action.step.seq)) return state;
      const last = state.steps[state.steps.length - 1];
      const steps =
        !last || last.seq < action.step.seq ? [...state.steps, action.step] : sortSteps([...state.steps, action.step]);
      return { ...state, steps };
    }
    case 'status':
      return {
        ...state,
        status: action.status,
        draftReadyAt: action.draftReadyAt ?? state.draftReadyAt,
        finishedAt: action.finishedAt ?? state.finishedAt,
      };
    case 'done':
      return { ...state, done: true, connected: false };
    case 'disconnected':
      return { ...state, connected: false };
    case 'error':
      return { ...state, connected: false, error: action.message };
    default:
      return state;
  }
}

const STEP_KINDS: ReadonlySet<string> = new Set([
  'info',
  'tool_call',
  'tool_result',
  'check',
  'decision',
  'review',
  'error',
]);

const RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'running',
  'draft_ready',
  'failed',
  'submitted',
  'conceded',
]);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toStep(raw: unknown): StreamStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const seq = typeof r.seq === 'number' ? r.seq : Number(r.seq);
  if (!Number.isFinite(seq)) return null;
  const kind = typeof r.kind === 'string' && STEP_KINDS.has(r.kind) ? (r.kind as StepKind) : 'info';
  let payload: unknown = r.payload ?? r.payload_json ?? null;
  if (typeof payload === 'string') {
    const parsed = parseJson(payload);
    payload = parsed ?? payload;
  }
  return {
    seq,
    kind,
    label: typeof r.label === 'string' ? r.label : '',
    payload,
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : new Date().toISOString(),
  };
}

export type UseDisputeStreamOptions = {
  initialSteps?: StreamStep[];
  enabled?: boolean;
};

/**
 * Subscribes to GET /api/disputes/:id/stream?run=<runId> (SSE).
 * The server sends the stored backlog first, then live bus events, then `done`.
 */
export function useDisputeStream(
  disputeId: string | null | undefined,
  runId: string | null | undefined,
  options: UseDisputeStreamOptions = {},
): DisputeStreamState & { reconnect: () => void } {
  const { initialSteps, enabled = true } = options;
  const [state, dispatch] = useReducer(reducer, initialState, (s) => ({
    ...s,
    steps: initialSteps ? sortSteps(initialSteps) : [],
  }));
  const [attempt, setAttempt] = useState(0);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    dispatch({ type: 'reset', steps: initialSteps ?? [] });
    // initialSteps intentionally excluded: only a new run resets the trace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disputeId, runId]);

  useEffect(() => {
    if (!enabled || !disputeId || !runId) return;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      dispatch({ type: 'error', message: 'This browser does not support live streaming.' });
      return;
    }

    let closed = false;
    const url = `/api/disputes/${encodeURIComponent(disputeId)}/stream?run=${encodeURIComponent(runId)}`;
    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch (err) {
      dispatch({ type: 'error', message: err instanceof Error ? err.message : 'Could not open the live stream.' });
      return;
    }

    const close = () => {
      if (closed) return;
      closed = true;
      source.close();
    };

    source.onopen = () => dispatch({ type: 'open' });

    source.addEventListener('step', (ev) => {
      const step = toStep(parseJson((ev as MessageEvent<string>).data));
      if (step) dispatch({ type: 'step', step });
    });

    source.addEventListener('status', (ev) => {
      const data = parseJson((ev as MessageEvent<string>).data) as Record<string, unknown> | null;
      if (!data || typeof data.status !== 'string' || !RUN_STATUSES.has(data.status)) return;
      dispatch({
        type: 'status',
        status: data.status as RunStatus,
        draftReadyAt: typeof data.draft_ready_at === 'string' ? data.draft_ready_at : null,
        finishedAt: typeof data.finished_at === 'string' ? data.finished_at : null,
      });
    });

    source.addEventListener('done', () => {
      dispatch({ type: 'done' });
      close();
    });

    source.onerror = () => {
      if (closed) return;
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: 'error', message: 'Live stream closed. Retry to reconnect.' });
        close();
      } else {
        // EventSource reconnects by itself; the backlog replay is deduped by seq.
        dispatch({ type: 'disconnected' });
      }
    };

    return close;
  }, [disputeId, runId, enabled, attempt]);

  return { ...state, reconnect };
}

export default useDisputeStream;