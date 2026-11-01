/**
 * First PayPal milestone: submit data/static-evidence.pdf to a real sandbox
 * dispute through provide-evidence and print the status and debug_id.
 *
 * Usage: tsx scripts/smoke-provide-evidence.ts <disputeId> [--tracking <number>] [--carrier USPS] [--force]
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

const ALLOWED: Record<string, string[]> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_DELIVERY_SIGNATURE', 'OTHER'],
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: ['ITEM_DESCRIPTION', 'RETURN_POLICY', 'PROOF_OF_FULFILLMENT', 'OTHER'],
  UNAUTHORISED: ['PROOF_OF_FULFILLMENT', 'PROOF_OF_DELIVERY_SIGNATURE', 'OTHER'],
};

type Dispute = {
  dispute_id: string;
  reason: string;
  status: string;
  seller_response_due_date?: string;
  disputed_transactions?: { seller_transaction_id?: string }[];
};

function loadEnv(): void {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // No .env file: rely on the process environment.
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
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

function openDbIfPresent(): Database.Database | null {
  const dbPath = path.resolve(process.cwd(), process.env.DATABASE_PATH ?? './data/app.db');
  if (!existsSync(dbPath)) return null;
  try {
    return new Database(dbPath);
  } catch {
    return null;
  }
}

function logCall(
  db: Database.Database | null,
  row: { dispute_id: string; method: string; path: string; status_code: number | null; debug_id: string | null; duration_ms: number; error_message?: string | null },
): void {
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO paypal_calls (dispute_id, run_id, method, path, status_code, debug_id, duration_ms, error_name, error_message, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(row.dispute_id, row.method, row.path, row.status_code, row.debug_id, row.duration_ms, row.error_message ?? null, new Date().toISOString());
  } catch (err) {
    console.warn(`Could not log PayPal call: ${(err as Error).message}`);
  }
}

function trackingFromDb(db: Database.Database | null, captureId: string | undefined): { number: string; carrier: string } | null {
  if (!db || !captureId) return null;
  try {
    const row = db.prepare('SELECT tracking_number, carrier FROM orders WHERE capture_id = ?').get(captureId) as
      | { tracking_number: string | null; carrier: string | null }
      | undefined;
    return row?.tracking_number ? { number: row.tracking_number, carrier: row.carrier ?? 'USPS' } : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnv();
  const disputeId = process.argv[2];
  if (!disputeId || disputeId.startsWith('--')) {
    throw new Error('Usage: tsx scripts/smoke-provide-evidence.ts <disputeId> [--tracking <number>] [--carrier USPS] [--force]');
  }
  if (disputeId.startsWith('PP-D-FX-')) throw new Error('That is a fixture dispute; it cannot be submitted to PayPal.');
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required');

  const pdfPath = path.resolve(process.cwd(), 'data/static-evidence.pdf');
  if (!existsSync(pdfPath)) throw new Error('data/static-evidence.pdf missing; run: tsx scripts/make-static-evidence.ts');
  const pdf = readFileSync(pdfPath);
  if (pdf.length > MAX_BYTES) throw new Error(`PDF is ${pdf.length} bytes; PayPal limit is 10 MB`);

  const base = paypalBase();
  const db = openDbIfPresent();
  try {
    const token = await getAccessToken(base, clientId, secret);

    const showPath = `/v1/customer/disputes/${encodeURIComponent(disputeId)}`;
    let started = Date.now();
    const showRes = await fetch(`${base}${showPath}`, { headers: { Authorization: `Bearer ${token}` } });
    const showDebug = showRes.headers.get('paypal-debug-id');
    logCall(db, { dispute_id: disputeId, method: 'GET', path: showPath, status_code: showRes.status, debug_id: showDebug, duration_ms: Date.now() - started });
    if (!showRes.ok) throw new Error(`GET dispute failed: ${showRes.status} debug_id=${showDebug ?? '-'} ${await showRes.text()}`);
    const dispute = (await showRes.json()) as Dispute;
    console.log(`Dispute ${dispute.dispute_id}: reason=${dispute.reason} status=${dispute.status} due=${dispute.seller_response_due_date ?? '-'}`);

    const force = process.argv.includes('--force');
    if (dispute.status !== 'WAITING_FOR_SELLER_RESPONSE' && !force) {
      throw new Error(`Status is ${dispute.status}, not WAITING_FOR_SELLER_RESPONSE. Use Sandbox controls -> require-evidence first, or pass --force.`);
    }
    if (dispute.seller_response_due_date && Date.now() >= Date.parse(dispute.seller_response_due_date) && !force) {
      throw new Error('The seller response deadline has passed.');
    }

    const allowed = ALLOWED[dispute.reason] ?? ['OTHER'];
    const captureId = dispute.disputed_transactions?.[0]?.seller_transaction_id;
    const cliTracking = argValue('--tracking');
    const tracking = cliTracking ? { number: cliTracking, carrier: argValue('--carrier') ?? 'USPS' } : trackingFromDb(db, captureId);

    const fileName = `evidence-${disputeId}.pdf`;
    const evidence: Record<string, unknown> =
      tracking && allowed.includes('PROOF_OF_FULFILLMENT')
        ? {
            evidence_type: 'PROOF_OF_FULFILLMENT',
            evidence_info: { tracking_info: [{ carrier_name: tracking.carrier, tracking_number: tracking.number }] },
            notes: 'Order shipped with carrier tracking. Details in the attached evidence packet.',
            documents: [{ name: fileName }],
          }
        : {
            evidence_type: 'OTHER',
            notes: 'Seller evidence packet attached.',
            documents: [{ name: fileName }],
          };
    console.log(`Submitting evidence_type=${String(evidence.evidence_type)}${tracking ? ` tracking=${tracking.number}` : ''}`);

    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({ evidences: [evidence] })], { type: 'application/json' }));
    form.append('file1', new Blob([pdf], { type: 'application/pdf' }), fileName);

    const evPath = `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`;
    started = Date.now();
    const res = await fetch(`${base}${evPath}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    const debugId = res.headers.get('paypal-debug-id');
    const text = await res.text();
    logCall(db, {
      dispute_id: disputeId,
      method: 'POST',
      path: evPath,
      status_code: res.status,
      debug_id: debugId,
      duration_ms: Date.now() - started,
      error_message: res.ok ? null : text.slice(0, 1000),
    });

    console.log(`provide-evidence -> ${res.status}`);
    console.log(`debug_id=${debugId ?? '-'}`);
    if (text) console.log(text);
    if (!res.ok) process.exitCode = 1;
  } finally {
    db?.close();
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});