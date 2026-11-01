import { z } from "zod";

const optionalString = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().trim().optional(),
);

function flag(defaultValue: boolean) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((v) => {
        if (v === undefined) return defaultValue;
        if (typeof v === "boolean") return v;
        return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
      }),
  );
}

function nonNegativeNumber(defaultValue: number) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().finite().nonnegative().default(defaultValue),
  );
}

function positiveInt(defaultValue: number) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().default(defaultValue),
  );
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: optionalString,
  PAYPAL_CLIENT_SECRET: optionalString,
  PAYPAL_WEBHOOK_ID: optionalString,
  NEXT_PUBLIC_PAYPAL_CLIENT_ID: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL_AGENT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("claude-sonnet-5-5"),
  ),
  ANTHROPIC_MODEL_REVIEW: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("claude-opus-5-5"),
  ),
  REVIEW_ENABLED: flag(true),
  DATABASE_PATH: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().default("./data/app.db"),
  ),
  PUBLIC_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .url()
      .transform((u) => u.replace(/\/+$/, ""))
      .optional(),
  ),
  DISPUTE_FEE_USD: nonNegativeNumber(0),
  SELLER_TIME_COST_USD: nonNegativeNumber(15),
  DEMO_TRIGGER_PER_IP_PER_MIN: positiveInt(1),
  DEMO_TRIGGER_GLOBAL_PER_HOUR: positiveInt(10),
  PAYPAL_MOCK: flag(false),
  ANTHROPIC_MOCK: flag(false),
  POLL_INTERVAL_MS: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().min(5_000).default(30_000),
  ),
  PORT: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

const g = globalThis as unknown as { __ddEnv?: Env };

/**
 * Parses and validates process.env once. Throws a readable error listing
 * every invalid variable, so a misconfigured deploy fails on first use
 * instead of half-working.
 */
export function getEnv(): Env {
  if (g.__ddEnv) return g.__ddEnv;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`,
    );
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  g.__ddEnv = parsed.data;
  return parsed.data;
}

/** Test hook: forget the cached env so changes to process.env take effect. */
export function resetEnvCache(): void {
  g.__ddEnv = undefined;
}

/** Lazy, read-only view over getEnv() so `env.X` works at import sites. */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop) {
    return getEnv()[prop as keyof Env];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getEnv(), prop);
  },
  set() {
    throw new Error("env is read-only");
  },
});

export function isPaypalMock(): boolean {
  return getEnv().PAYPAL_MOCK;
}

export function isAnthropicMock(): boolean {
  return getEnv().ANTHROPIC_MOCK;
}

export function isSandbox(): boolean {
  return getEnv().PAYPAL_ENV === "sandbox";
}

export function hasPaypalCredentials(): boolean {
  const e = getEnv();
  return Boolean(e.PAYPAL_CLIENT_ID && e.PAYPAL_CLIENT_SECRET);
}

/** True when PayPal calls can actually be made (real credentials or mock adapter). */
export function paypalAvailable(): boolean {
  return isPaypalMock() || hasPaypalCredentials();
}

export function paypalBaseUrl(): string {
  return getEnv().PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function requirePaypalCredentials(): { clientId: string; clientSecret: string } {
  const e = getEnv();
  if (!e.PAYPAL_CLIENT_ID || !e.PAYPAL_CLIENT_SECRET) {
    throw new Error(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set (see .env.example), or set PAYPAL_MOCK=1 for tests.",
    );
  }
  return { clientId: e.PAYPAL_CLIENT_ID, clientSecret: e.PAYPAL_CLIENT_SECRET };
}

export function requireAnthropicKey(): string {
  const e = getEnv();
  if (!e.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY must be set (see .env.example), or set ANTHROPIC_MOCK=1 for tests.",
    );
  }
  return e.ANTHROPIC_API_KEY;
}