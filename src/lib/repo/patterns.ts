import { getDb } from '../db';
import { nanoid } from 'nanoid';

export interface PatternQuote {
  dispute_id: string;
  message_ref: string;
  quote: string;
}

export interface PatternRow {
  id: string;
  sku: string | null;
  reason: string;
  theme: string;
  dispute_count: number;
  matching_count: number;
  quotes_json: string;
  headline: string;
  action: string;
  includes_fixture: number;
  computed_at: string;
}

export interface Pattern extends Omit<PatternRow, 'includes_fixture'> {
  quotes: PatternQuote[];
  includes_fixture: boolean;
}

export interface PatternInput {
  sku: string | null;
  reason: string;
  theme: string;
  dispute_count: number;
  matching_count: number;
  quotes: PatternQuote[];
  headline: string;
  action: string;
  includes_fixture: boolean;
}

function hydrate(row: PatternRow): Pattern {
  let quotes: PatternQuote[] = [];
  try {
    const v = JSON.parse(row.quotes_json) as unknown;
    if (Array.isArray(v)) quotes = v as PatternQuote[];
  } catch {
    quotes = [];
  }
  return { ...row, quotes, includes_fixture: row.includes_fixture === 1 };
}

/** Replaces the full pattern set atomically, so readers never see a half-mined table. */
export function replacePatterns(inputs: PatternInput[]): Pattern[] {
  const db = getDb();
  const computedAt = new Date().toISOString();
  const tx = db.transaction((items: PatternInput[]) => {
    db.prepare(`DELETE FROM patterns`).run();
    const stmt = db.prepare(
      `INSERT INTO patterns (id, sku, reason, theme, dispute_count, matching_count, quotes_json, headline, action,
                             includes_fixture, computed_at)
       VALUES (@id, @sku, @reason, @theme, @dispute_count, @matching_count, @quotes_json, @headline, @action,
               @includes_fixture, @computed_at)`,
    );
    for (const p of items) {
      if (p.matching_count > p.dispute_count) {
        throw new Error(`Pattern ${p.sku}/${p.reason}/${p.theme}: matching_count exceeds dispute_count`);
      }
      stmt.run({
        id: `pat_${nanoid(10)}`,
        sku: p.sku,
        reason: p.reason,
        theme: p.theme,
        dispute_count: p.dispute_count,
        matching_count: p.matching_count,
        quotes_json: JSON.stringify(p.quotes),
        headline: p.headline,
        action: p.action,
        includes_fixture: p.includes_fixture ? 1 : 0,
        computed_at: computedAt,
      });
    }
  });
  tx(inputs);
  return listPatterns();
}

export function listPatterns(): Pattern[] {
  const rows = getDb()
    .prepare(`SELECT * FROM patterns ORDER BY matching_count DESC, dispute_count DESC, sku ASC`)
    .all() as PatternRow[];
  return rows.map(hydrate);
}

export function getPatternsComputedAt(): string | null {
  const row = getDb().prepare(`SELECT MAX(computed_at) AS t FROM patterns`).get() as { t: string | null };
  return row.t ?? null;
}