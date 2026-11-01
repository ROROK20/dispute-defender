import { EventEmitter } from "node:events";

export interface StepEventData {
  seq: number;
  kind: string;
  label: string;
  payload: unknown;
  duration_ms: number | null;
  created_at: string;
}

export interface StatusEventData {
  status: string;
  draft_ready_at?: string | null;
  finished_at?: string | null;
  error?: string | null;
}

export type RunBusEvent =
  | { type: "step"; data: StepEventData }
  | { type: "status"; data: StatusEventData }
  | { type: "done"; data: Record<string, never> };

const g = globalThis as unknown as { __ddBus?: EventEmitter };

function createBus(): EventEmitter {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  return e;
}

/** One emitter per process, kept on globalThis so it survives HMR. */
export const bus: EventEmitter = g.__ddBus ?? (g.__ddBus = createBus());

export function runChannel(runId: string): string {
  return `run:${runId}`;
}

export function emitRunEvent(runId: string, event: RunBusEvent): void {
  try {
    bus.emit(runChannel(runId), event);
  } catch (err) {
    console.error(`[bus] listener for ${runChannel(runId)} threw:`, err);
  }
}

export function emitStep(runId: string, data: StepEventData): void {
  emitRunEvent(runId, { type: "step", data });
}

export function emitStatus(runId: string, data: StatusEventData): void {
  emitRunEvent(runId, { type: "status", data });
}

export function emitDone(runId: string): void {
  emitRunEvent(runId, { type: "done", data: {} });
}

/** Subscribe to one run's events. Returns an unsubscribe function. */
export function onRunEvent(runId: string, listener: (event: RunBusEvent) => void): () => void {
  const channel = runChannel(runId);
  bus.on(channel, listener);
  return () => {
    bus.off(channel, listener);
  };
}