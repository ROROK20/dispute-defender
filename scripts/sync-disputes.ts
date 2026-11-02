/**
 * Runs one dispute sync pass (the same one the poller runs) and prints the result.
 *
 * Usage: npm run sync
 */

export {};

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
  // Imported after loadEnv() so the module graph sees the .env values.
  const { syncDisputes } = await import('../src/lib/sync');
  const started = Date.now();
  const result = await syncDisputes();
  console.log(JSON.stringify({ ok: true, duration_ms: Date.now() - started, result: result ?? null }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`Sync failed: ${(err as Error).message}`);
    process.exit(1);
  });