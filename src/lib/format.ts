import { differenceInMilliseconds, format as formatDate, parseISO } from "date-fns";

export function centsFromValue(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** PayPal money value string, e.g. 4250 → "42.50". */
export function valueFromCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${valueFromCents(cents)} ${currency}`;
  }
}

/** 38400 → "38.4 s", 72000 → "1 m 12 s", 3_900_000 → "1 h 5 m". */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m} m ${s} s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h} h ${m} m`;
}

/** Stopwatch style: 00:41.3 or 1:02:05. */
export function formatStopwatch(ms: number): string {
  const safe = Math.max(0, ms);
  const totalTenths = Math.floor(safe / 100);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}.${tenths}`;
}

export function elapsedMs(startIso: string | null | undefined, endIso: string | null | undefined): number | null {
  if (!startIso || !endIso) return null;
  try {
    const ms = differenceInMilliseconds(parseISO(endIso), parseISO(startIso));
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

export type DeadlineTone = "none" | "ok" | "soon" | "overdue";

export const DUE_SOON_MS = 48 * 60 * 60 * 1000;

export function formatCountdown(
  dueIso: string | null | undefined,
  nowMs: number = Date.now(),
): { label: string; tone: DeadlineTone; ms: number | null } {
  if (!dueIso) return { label: "No deadline", tone: "none", ms: null };
  const due = Date.parse(dueIso);
  if (!Number.isFinite(due)) return { label: "No deadline", tone: "none", ms: null };
  const ms = due - nowMs;
  if (ms <= 0) return { label: `Overdue ${compactSpan(-ms)}`, tone: "overdue", ms };
  return { label: `${compactSpan(ms)} left`, tone: ms < DUE_SOON_MS ? "soon" : "ok", ms };
}

function compactSpan(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${Math.max(min, 1)}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDate(parseISO(iso), "MMM d, yyyy HH:mm");
  } catch {
    return iso;
  }
}

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDate(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}

const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Item not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized transaction",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate transaction",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Canceled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Problem with remittance",
  OTHER: "Other",
};

const REASON_SHORT: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "INR",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "SNAD",
  UNAUTHORISED: "UNAUTH",
};

export function reasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Unknown";
  return REASON_LABELS[reason] ?? humanize(reason);
}

export function reasonShort(reason: string | null | undefined): string {
  if (!reason) return "—";
  return REASON_SHORT[reason] ?? humanize(reason);
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_FOR_SELLER_RESPONSE: "Needs response",
  WAITING_FOR_BUYER_RESPONSE: "Waiting on buyer",
  UNDER_REVIEW: "Under review",
  RESOLVED: "Resolved",
  OTHER: "Other",
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return STATUS_LABELS[status] ?? humanize(status);
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Agent running",
  draft_ready: "Draft ready",
  failed: "Run failed",
  submitted: "Evidence submitted",
  conceded: "Conceded",
};

export function runStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return RUN_STATUS_LABELS[status] ?? humanize(status);
}

const RECOMMENDATION_LABELS: Record<string, string> = {
  FIGHT: "Fight",
  ACCEPT_CLAIM: "Accept & refund",
  MAKE_OFFER: "Make offer",
};

export function recommendationLabel(rec: string | null | undefined): string {
  if (!rec) return "—";
  return RECOMMENDATION_LABELS[rec] ?? humanize(rec);
}

export function humanize(code: string): string {
  return code
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}