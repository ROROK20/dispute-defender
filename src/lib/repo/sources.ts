import { getDb } from '../db';

export type SourceKind =
  | 'dispute_field'
  | 'order_field'
  | 'capture_field'
  | 'tracking_event'
  | 'buyer_message'
  | 'seller_message'
  | 'policy_clause'
  | 'sku_field';

export interface Source {
  run_id: string;
  source_key: string;
  kind: SourceKind;
  title: string;
  content: string;
  ref: string | null;
  fetched_at: string;
}

export interface SourceInput {
  kind: SourceKind;
  title: string;
  content: string;
  ref?: string | null;
}

/** Stores a source and assigns the next key (S1, S2, …) for the run, atomically. */
export function insertSource(runId: string, input: SourceInput): Source {
  return insertSources(runId, [input])[0];
}

export function insertSources(runId: string, inputs: SourceInput[]): Source[] {
  const db = getDb();
  const tx = db.transaction((items: SourceInput[]): Source[] => {
    const { n } = db.prepare(`SELECT COUNT(*) AS n FROM sources WHERE run_id = ?`).get(runId) as { n: number };
    const fetchedAt = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO sources (run_id, source_key, kind, title, content, ref, fetched_at)
       VALUES (@run_id, @source_key, @kind, @title, @content, @ref, @fetched_at)`,
    );
    return items.map((item, i) => {
      const row: Source = {
        run_id: runId,
        source_key: `S${n + i + 1}`,
        kind: item.kind,
        title: item.title.slice(0, 300),
        content: item.content,
        ref: item.ref ?? null,
        fetched_at: fetchedAt,
      };
      stmt.run(row);
      return row;
    });
  });
  return tx(inputs);
}

export function listSources(runId: string): Source[] {
  const rows = getDb()
    .prepare(`SELECT * FROM sources WHERE run_id = ?`)
    .all(runId) as Source[];
  return rows.sort((a, b) => Number(a.source_key.slice(1)) - Number(b.source_key.slice(1)));
}

export function getSourcesByKey(runId: string): Record<string, Source> {
  const map: Record<string, Source> = {};
  for (const s of listSources(runId)) map[s.source_key] = s;
  return map;
}

export function getSource(runId: string, sourceKey: string): Source | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM sources WHERE run_id = ? AND source_key = ?`)
      .get(runId, sourceKey) as Source | undefined) ?? null
  );
}