/**
 * Runs one dispute sync pass (the same one the poller runs) and prints the result.
 *
 * Usage: npm run sync
 */

function loadEnv(): void {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file: rely on the process environment.
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (!process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_MOCK !== '1') {
    throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required (or PAYPAL_MOCK=1)');
  }
  const mod = (await import('../src/lib/sync')) as Record<string, unknown>;
  const name = ['syncDisputes', 'syncOnce', 'runSync', 'pollOnce', 'sync'].find((n) => typeof mod[n] === 'function');
  if (!name) throw new Error('src/lib/sync.ts exports no one-shot sync function');
  const started = Date.now();
  const result = await (mod[name] as () => Promise<unknown>)();
  console.log(JSON.stringify({ ok: true, duration_ms: Date.now() - started, result: result ?? null }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Sync failed: ${(err as Error).message}`);
    process.exit(1);
  });