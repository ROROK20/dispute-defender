import { getDb } from '../db';

export interface PaypalCallRow {
  id: number;
  dispute_id: string | null;
  run_id: string | null;
  method: string;
  path: string;
  status_code: number | null;
  debug_id: string | null;
  duration_ms: number | null;
  error_name: string | null;
  error_message: string | null;
  created_at: string;
}

export interface PaypalCallInput {
  dispute_id?: string | null;
  run_id?: string | null;
  method: string;
  path: string;
  status_code?: number | null;
  debug_id?: string | null;
  duration_ms?: number | null;
  error_name?: string | null;
  error_message?: string | null;
}

/** Logs one PayPal call. Never throws: logging must not break the call it records. */
export function insertPaypalCall(input: PaypalCallInput): number | null {
  try {
    const res = getDb()
      .prepare(
        `INSERT INTO paypal_calls (dispute_id, run_id, method, path, status_code, debug_id, duration_ms,
                                   error_name, error_message, created_at)
         VALUES (@dispute_id, @run_id, @method, @path, @status_code, @debug_id, @duration_ms,
                 @error_name, @error_message, @created_at)`,
      )
      .run({
        dispute_id: input.dispute_id ?? null,
        run_id: input.run_id ?? null,
        method: input.method.toUpperCase(),
        path: input.path,
        status_code: input.status_code ?? null,
        debug_id: input.debug_id ?? null,
        duration_ms: input.duration_ms == null ? null : Math.round(input.duration_ms),
        error_name: input.error_name ?? null,
        error_message: input.error_message ? input.error_message.slice(0, 2000) : null,
        created_at: new Date().toISOString(),
      });
    return Number(res.lastInsertRowid);
  } catch (err) {
    console.error('[paypal_calls] failed to log call', input.method, input.path, err);
    return null;
  }
}

export function getPaypalCall(id: number): PaypalCallRow | null {
  return (getDb().prepare(`SELECT * FROM paypal_calls WHERE id = ?`).get(id) as PaypalCallRow | undefined) ?? null;
}

export function listPaypalCalls(opts: { dispute_id?: string; run_id?: string; limit?: number } = {}): PaypalCallRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 2000);
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.dispute_id) {
    where.push('dispute_id = @dispute_id');
    params.dispute_id = opts.dispute_id;
  }
  if (opts.run_id) {
    where.push('run_id = @run_id');
    params.run_id = opts.run_id;
  }
  return getDb()
    .prepare(
      `SELECT * FROM paypal_calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC LIMIT @limit`,
    )
    .all(params) as PaypalCallRow[];
}