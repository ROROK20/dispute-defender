/**
 * Registers the three dispute webhook events at ${PUBLIC_BASE_URL}/api/webhooks/paypal
 * and prints the webhook id for PAYPAL_WEBHOOK_ID. If the URL is already registered,
 * finds and prints the existing id.
 *
 * Usage: npm run webhook:register
 */

const EVENT_TYPES = ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED', 'CUSTOMER.DISPUTE.RESOLVED'];

function loadEnv(): void {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file: rely on the process environment.
  }
}

function paypalBase(): string {
  return process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken(base: string, clientId: string, secret: string): Promise<string> {
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    throw new Error(`OAuth failed: ${res.status} debug_id=${res.headers.get('paypal-debug-id') ?? '-'} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('OAuth response had no access_token');
  return json.access_token;
}

type WebhookListResponse = { webhooks?: { id: string; url: string; event_types?: { name: string }[] }[] };

async function findExisting(base: string, token: string, url: string): Promise<string | null> {
  const res = await fetch(`${base}/v1/notifications/webhooks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`List webhooks failed: ${res.status} debug_id=${res.headers.get('paypal-debug-id') ?? '-'}`);
  }
  const json = (await res.json()) as WebhookListResponse;
  return json.webhooks?.find((w) => w.url === url)?.id ?? null;
}

async function main(): Promise<void> {
  loadEnv();
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  const publicBase = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');
  if (!publicBase) throw new Error('PUBLIC_BASE_URL is required (your Render URL or ngrok https URL)');
  if (!publicBase.startsWith('https://')) throw new Error('PayPal requires an https webhook URL; PUBLIC_BASE_URL must start with https://');

  const base = paypalBase();
  const url = `${publicBase}/api/webhooks/paypal`;
  const token = await getAccessToken(base, clientId, secret);

  const res = await fetch(`${base}/v1/notifications/webhooks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, event_types: EVENT_TYPES.map((name) => ({ name })) }),
  });
  const debugId = res.headers.get('paypal-debug-id') ?? '-';
  const text = await res.text();
  let body: { id?: string; name?: string; message?: string } = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (res.ok && body.id) {
    console.log(`Registered webhook for ${url} (debug_id=${debugId})`);
    console.log(`PAYPAL_WEBHOOK_ID=${body.id}`);
    return;
  }

  if (body.name === 'WEBHOOK_URL_ALREADY_EXISTS') {
    const existing = await findExisting(base, token, url);
    if (existing) {
      console.log(`Webhook already registered for ${url}`);
      console.log(`PAYPAL_WEBHOOK_ID=${existing}`);
      return;
    }
  }

  throw new Error(`Register webhook failed: ${res.status} debug_id=${debugId} ${text}`);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});