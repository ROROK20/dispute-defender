import { getEnv } from "./env";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface BucketSpec {
  capacity: number;
  windowMs: number;
}

export interface LimitResult {
  ok: boolean;
  retryAfterMs: number;
  scope?: "ip" | "global";
}

const g = globalThis as unknown as { __ddBuckets?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = g.__ddBuckets ?? (g.__ddBuckets = new Map());

function refill(key: string, spec: BucketSpec, now: number): Bucket {
  const rate = spec.capacity / spec.windowMs;
  const existing = buckets.get(key);
  if (!existing) {
    const fresh = { tokens: spec.capacity, updatedAt: now };
    buckets.set(key, fresh);
    return fresh;
  }
  const elapsed = Math.max(0, now - existing.updatedAt);
  existing.tokens = Math.min(spec.capacity, existing.tokens + elapsed * rate);
  existing.updatedAt = now;
  return existing;
}

function msUntilToken(bucket: Bucket, spec: BucketSpec): number {
  if (bucket.tokens >= 1) return 0;
  const rate = spec.capacity / spec.windowMs;
  return Math.ceil((1 - bucket.tokens) / rate);
}

/** Token bucket: takes one token from `key` if available. */
export function takeToken(key: string, spec: BucketSpec, now: number = Date.now()): LimitResult {
  const bucket = refill(key, spec, now);
  if (bucket.tokens < 1) return { ok: false, retryAfterMs: msUntilToken(bucket, spec) };
  bucket.tokens -= 1;
  return { ok: true, retryAfterMs: 0 };
}

/**
 * All-or-nothing across several buckets: a token is taken from every bucket
 * only when each one has a token, so a rejected request costs nothing.
 */
export function takeTokens(
  entries: { key: string; spec: BucketSpec; scope: "ip" | "global" }[],
  now: number = Date.now(),
): LimitResult {
  const states = entries.map((e) => ({ ...e, bucket: refill(e.key, e.spec, now) }));
  const blocked = states.find((s) => s.bucket.tokens < 1);
  if (blocked) {
    return { ok: false, retryAfterMs: msUntilToken(blocked.bucket, blocked.spec), scope: blocked.scope };
  }
  for (const s of states) s.bucket.tokens -= 1;
  return { ok: true, retryAfterMs: 0 };
}

export function checkDemoTriggerLimit(ip: string, now: number = Date.now()): LimitResult {
  const e = getEnv();
  return takeTokens(
    [
      {
        key: `demo:ip:${ip}`,
        spec: { capacity: e.DEMO_TRIGGER_PER_IP_PER_MIN, windowMs: 60_000 },
        scope: "ip",
      },
      {
        key: "demo:global",
        spec: { capacity: e.DEMO_TRIGGER_GLOBAL_PER_HOUR, windowMs: 3_600_000 },
        scope: "global",
      },
    ],
    now,
  );
}

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

export function resetRateLimits(): void {
  buckets.clear();
}