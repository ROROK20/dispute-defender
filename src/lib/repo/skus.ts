import { getDb } from '../db';

export interface SkuRow {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  cogs_cents: number;
  description: string;
  size_chart_version: string | null;
}

export interface SkuInput {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  cogs_cents: number;
  description: string;
  size_chart_version?: string | null;
}

function assertSkuInput(input: SkuInput): void {
  if (!input.sku || typeof input.sku !== 'string') throw new Error('SKU id is required');
  if (!Number.isInteger(input.price_cents) || input.price_cents < 0) {
    throw new Error(`SKU ${input.sku}: price_cents must be a non-negative integer`);
  }
  if (!Number.isInteger(input.cogs_cents) || input.cogs_cents < 0) {
    throw new Error(`SKU ${input.sku}: cogs_cents must be a non-negative integer`);
  }
}

export function upsertSku(input: SkuInput): SkuRow {
  assertSkuInput(input);
  const db = getDb();
  db.prepare(
    `INSERT INTO skus (sku, name, category, price_cents, cogs_cents, description, size_chart_version)
     VALUES (@sku, @name, @category, @price_cents, @cogs_cents, @description, @size_chart_version)
     ON CONFLICT(sku) DO UPDATE SET
       name = excluded.name,
       category = excluded.category,
       price_cents = excluded.price_cents,
       cogs_cents = excluded.cogs_cents,
       description = excluded.description,
       size_chart_version = excluded.size_chart_version`,
  ).run({
    sku: input.sku,
    name: input.name,
    category: input.category,
    price_cents: input.price_cents,
    cogs_cents: input.cogs_cents,
    description: input.description,
    size_chart_version: input.size_chart_version ?? null,
  });
  const row = getSku(input.sku);
  if (!row) throw new Error(`SKU ${input.sku} was not stored`);
  return row;
}

export function upsertSkus(inputs: SkuInput[]): number {
  const db = getDb();
  const tx = db.transaction((items: SkuInput[]) => {
    for (const item of items) upsertSku(item);
    return items.length;
  });
  return tx(inputs);
}

export function getSku(sku: string): SkuRow | null {
  const row = getDb().prepare(`SELECT * FROM skus WHERE sku = ?`).get(sku) as SkuRow | undefined;
  return row ?? null;
}

export function listSkus(): SkuRow[] {
  return getDb().prepare(`SELECT * FROM skus ORDER BY sku ASC`).all() as SkuRow[];
}

export function countSkus(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM skus`).get() as { n: number };
  return row.n;
}