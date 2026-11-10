/**
 * Pattern miner (C11).
 *
 * 1. Groups disputes by (sku, reason) deterministically.
 * 2. Claude tags each buyer message with themes from the closed list (themes.ts).
 * 3. CODE counts the tags: a dispute matches a theme if >= 1 of its buyer messages carries it.
 * 4. Every stored quote is verified as a verbatim substring of its message.
 * 5. Output is a headline ("4 of 6 SNAD claims on JT-114 mention sizing") plus a prevention action.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createMessage } from '@/lib/agent/anthropic';
import { nanoid } from 'nanoid';
import * as dbModule from '@/lib/db';
import {
  THEMES,
  THEME_DEFINITIONS,
  keywordTag,
  normalizeThemes,
  themeListForPrompt,
  type Theme,
} from './themes';

// ---------- types ----------

export interface MinerMessage {
  dispute_id: string;
  message_ref: string;
  posted_by: string;
  text: string;
  time_posted?: string | null;
}

export interface MinerDispute {
  id: string;
  sku: string | null;
  sku_name?: string | null;
  reason: string;
  source: 'paypal_sandbox' | 'fixture' | string;
  messages: MinerMessage[];
}

export interface MessageTag {
  dispute_id: string;
  message_ref: string;
  themes: Theme[];
  /** Verbatim quote per theme, already verified as a substring of the message. */
  quotes: Partial<Record<Theme, string>>;
}

export interface PatternQuote {
  dispute_id: string;
  message_ref: string;
  quote: string;
}

export interface Pattern {
  id: string;
  sku: string | null;
  reason: string;
  theme: Theme;
  dispute_count: number;
  matching_count: number;
  quotes: PatternQuote[];
  headline: string;
  action: string;
  includes_fixture: boolean;
  computed_at: string;
}

export interface DisputeGroup {
  key: string;
  sku: string | null;
  sku_name: string | null;
  reason: string;
  disputes: MinerDispute[];
}

export type Tagger = (messages: MinerMessage[]) => Promise<MessageTag[]>;

export interface MineOptions {
  /** Minimum disputes in a (sku, reason) group before a pattern is reported. */
  minGroupSize?: number;
  /** Minimum matching disputes before a theme becomes a pattern. */
  minMatching?: number;
  /** Max quotes stored per pattern. */
  maxQuotes?: number;
  now?: () => Date;
}

const DEFAULTS: Required<Omit<MineOptions, 'now'>> = { minGroupSize: 2, minMatching: 2, maxQuotes: 6 };

// ---------- reason labels ----------

const REASON_SHORT: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'INR',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'SNAD',
  UNAUTHORISED: 'unauthorised',
};

export function reasonShort(reason: string): string {
  return REASON_SHORT[reason] ?? reason.toLowerCase().replace(/_/g, ' ');
}

// ---------- pure helpers ----------

/** Case- and whitespace-normalized substring check; the quote must be verbatim text of the message. */
export function isVerbatimQuote(quote: string, message: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const q = norm(quote);
  if (q.length === 0) return false;
  return norm(message).includes(q);
}

/** Cut the sentence around `index` from `text`, so the quote is a true substring. */
export function sentenceAround(text: string, index: number, maxLen = 200): string {
  const safe = Math.max(0, Math.min(index, text.length));
  let start = safe;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  let end = safe;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  if (end < text.length) end++;
  let s = text.slice(start, end).trim();
  if (s.length > maxLen) {
    const rel = Math.max(0, safe - start - Math.floor(maxLen / 2));
    s = text.slice(start + rel, start + rel + maxLen).trim();
  }
  return s;
}

/** Deterministic grouping by (sku, reason). Order: sku asc (nulls last), then reason asc. */
export function groupDisputes(disputes: MinerDispute[]): DisputeGroup[] {
  const map = new Map<string, DisputeGroup>();
  for (const d of disputes) {
    const key = `${d.sku ?? '∅'}|${d.reason}`;
    let g = map.get(key);
    if (!g) {
      g = { key, sku: d.sku ?? null, sku_name: d.sku_name ?? null, reason: d.reason, disputes: [] };
      map.set(key, g);
    }
    if (!g.sku_name && d.sku_name) g.sku_name = d.sku_name;
    g.disputes.push(d);
  }
  const groups = [...map.values()];
  for (const g of groups) g.disputes.sort((a, b) => a.id.localeCompare(b.id));
  groups.sort((a, b) => {
    if (a.sku === b.sku) return a.reason.localeCompare(b.reason);
    if (a.sku === null) return 1;
    if (b.sku === null) return -1;
    return a.sku.localeCompare(b.sku);
  });
  return groups;
}

export function buildHeadline(matching: number, total: number, reason: string, sku: string | null, theme: Theme): string {
  const on = sku ? ` on ${sku}` : '';
  const verb = matching === 1 ? 'mentions' : 'mention';
  return `${matching} of ${total} ${reasonShort(reason)} claims${on} ${verb} ${THEME_DEFINITIONS[theme].headlinePhrase}`;
}

/**
 * Code counts the tags. Pure function: given groups and message tags, returns patterns.
 * A dispute counts toward a theme once, no matter how many of its messages carry it.
 */
export function countPatterns(groups: DisputeGroup[], tags: MessageTag[], opts: MineOptions = {}): Pattern[] {
  const o = { ...DEFAULTS, ...opts };
  const computedAt = (opts.now ? opts.now() : new Date()).toISOString();

  const tagsByDispute = new Map<string, MessageTag[]>();
  for (const t of tags) {
    const arr = tagsByDispute.get(t.dispute_id) ?? [];
    arr.push(t);
    tagsByDispute.set(t.dispute_id, arr);
  }

  const patterns: Pattern[] = [];
  for (const g of groups) {
    const total = g.disputes.length;
    if (total < o.minGroupSize) continue;

    for (const theme of THEMES) {
      const matchingIds = new Set<string>();
      const quotes: PatternQuote[] = [];

      for (const d of g.disputes) {
        const dTags = tagsByDispute.get(d.id) ?? [];
        const messageText = new Map(d.messages.map((m) => [m.message_ref, m.text]));
        let matched = false;
        for (const t of dTags) {
          if (!t.themes.includes(theme)) continue;
          const msg = messageText.get(t.message_ref);
          if (msg === undefined) continue; // tag on unknown message: ignored
          matched = true;
          const q = t.quotes[theme];
          if (q && isVerbatimQuote(q, msg) && quotes.length < o.maxQuotes && !quotes.some((x) => x.dispute_id === d.id)) {
            quotes.push({ dispute_id: d.id, message_ref: t.message_ref, quote: q });
          }
        }
        if (matched) matchingIds.add(d.id);
      }

      const matching = matchingIds.size;
      if (matching < o.minMatching) continue;

      patterns.push({
        id: `pat_${(g.sku ?? 'none').replace(/[^A-Za-z0-9-]/g, '')}_${reasonShort(g.reason).replace(/\s+/g, '_')}_${theme}`,
        sku: g.sku,
        reason: g.reason,
        theme,
        dispute_count: total,
        matching_count: matching,
        quotes,
        headline: buildHeadline(matching, total, g.reason, g.sku, theme),
        action: THEME_DEFINITIONS[theme].action(g.sku, g.sku_name),
        includes_fixture: g.disputes.some((d) => d.source === 'fixture'),
        computed_at: computedAt,
      });
    }
  }

  patterns.sort(
    (a, b) =>
      b.matching_count / b.dispute_count - a.matching_count / a.dispute_count ||
      b.matching_count - a.matching_count ||
      a.headline.localeCompare(b.headline),
  );
  return patterns;
}

// ---------- message extraction ----------

interface RawMessage {
  id?: string;
  message_id?: string;
  posted_by?: string;
  time_posted?: string;
  content?: string;
  message?: string;
  text?: string;
}

/** Pull buyer messages from a stored dispute raw_json (PayPal `messages[]` shape). */
export function extractBuyerMessages(disputeId: string, raw: unknown): MinerMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(list)) return [];
  const out: MinerMessage[] = [];
  list.forEach((m: RawMessage, i: number) => {
    if (!m || typeof m !== 'object') return;
    const postedBy = String(m.posted_by ?? '').toUpperCase();
    if (postedBy !== 'BUYER') return;
    const text = String(m.content ?? m.message ?? m.text ?? '').trim();
    if (!text) return;
    out.push({
      dispute_id: disputeId,
      message_ref: String(m.id ?? m.message_id ?? `${disputeId}#m${i + 1}`),
      posted_by: postedBy,
      text,
      time_posted: m.time_posted ?? null,
    });
  });
  return out;
}

// ---------- taggers ----------

/** Deterministic fallback tagger (mock mode, no key, or model failure). */
export const keywordTagger: Tagger = async (messages) =>
  messages.map((m) => {
    const { themes, hits } = keywordTag(m.text);
    const quotes: Partial<Record<Theme, string>> = {};
    for (const h of hits) quotes[h.theme] = sentenceAround(m.text, h.index);
    return { dispute_id: m.dispute_id, message_ref: m.message_ref, themes, quotes };
  });

const TAG_TOOL = {
  name: 'tag_messages',
  description: 'Tag each buyer message with zero or more themes from the closed list, with a verbatim quote per theme.',
  input_schema: {
    type: 'object' as const,
    properties: {
      tags: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            message_ref: { type: 'string' },
            themes: { type: 'array', items: { type: 'string', enum: [...THEMES] } },
            quotes: {
              type: 'array',
              items: {
                type: 'object',
                properties: { theme: { type: 'string', enum: [...THEMES] }, quote: { type: 'string' } },
                required: ['theme', 'quote'],
              },
            },
          },
          required: ['message_ref', 'themes', 'quotes'],
        },
      },
    },
    required: ['tags'],
  },
};

const BATCH_SIZE = 25;

function claudeTagger(): Tagger {
  return async (messages) => {
    const results: MessageTag[] = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE) {
      const batch = messages.slice(i, i + BATCH_SIZE);
      const byRef = new Map(batch.map((m) => [m.message_ref, m]));
      const prompt = [
        'You tag buyer messages from e-commerce disputes with root-cause themes.',
        'Use ONLY these themes (a message may have none):',
        themeListForPrompt(),
        '',
        'For every theme you assign, give a quote copied VERBATIM from the message (a short phrase or sentence). Do not paraphrase. Do not count anything; only tag.',
        '',
        'Messages (JSON):',
        JSON.stringify(batch.map((m) => ({ message_ref: m.message_ref, text: m.text }))),
        '',
        'Return the result by calling the tag_messages tool, with one entry per message.',
      ].join('\n');

      try {
        // Current Sonnet/Opus models reject forced tool_choice and sampling
        // parameters, so the tool is requested in the prompt instead.
        // Same seam as the agent: the Messages API, or the local Claude Code
        // CLI when ANTHROPIC_PROVIDER=claude-cli.
        const resp = await createMessage({
          role: 'agent',
          system: 'You tag buyer messages with root-cause themes and return them through the tag_messages tool.',
          maxTokens: 16_000,
          timeoutMs: 180_000,
          tools: [TAG_TOOL as Anthropic.Tool],
          messages: [{ role: 'user', content: prompt }],
        });
        const block = resp.content.find((b) => b.type === 'tool_use');
        const input = (block && block.type === 'tool_use' ? block.input : null) as {
          tags?: { message_ref?: unknown; themes?: unknown; quotes?: unknown }[];
        } | null;
        const seen = new Set<string>();
        for (const t of input?.tags ?? []) {
          const ref = typeof t.message_ref === 'string' ? t.message_ref : '';
          const msg = byRef.get(ref);
          if (!msg || seen.has(ref)) continue;
          seen.add(ref);
          const themes = normalizeThemes(t.themes);
          const quotes: Partial<Record<Theme, string>> = {};
          for (const q of Array.isArray(t.quotes) ? t.quotes : []) {
            const theme = (q as { theme?: unknown }).theme;
            const quote = (q as { quote?: unknown }).quote;
            if (typeof quote !== 'string') continue;
            const [th] = normalizeThemes([theme]);
            if (th && themes.includes(th) && isVerbatimQuote(quote, msg.text)) quotes[th] = quote.trim();
          }
          // Theme tagged but model quote not verbatim: cut a verified quote by keyword, else store none.
          for (const th of themes) {
            if (quotes[th]) continue;
            const hit = keywordTag(msg.text).hits.find((h) => h.theme === th);
            if (hit) quotes[th] = sentenceAround(msg.text, hit.index);
          }
          results.push({ dispute_id: msg.dispute_id, message_ref: ref, themes, quotes });
        }
        // Messages the model skipped are treated as untagged.
        for (const m of batch) {
          if (!seen.has(m.message_ref)) results.push({ dispute_id: m.dispute_id, message_ref: m.message_ref, themes: [], quotes: {} });
        }
      } catch (err) {
        console.error('[patterns] Claude tagging failed; using keyword tagger for this batch:', err instanceof Error ? err.message : err);
        results.push(...(await keywordTagger(batch)));
      }
    }
    return results;
  };
}

export function defaultTagger(): Tagger {
  const mock = process.env.ANTHROPIC_MOCK === '1' || process.env.ANTHROPIC_MOCK === 'true';
  const cli = process.env.ANTHROPIC_PROVIDER === 'claude-cli';
  if (mock || (!process.env.ANTHROPIC_API_KEY && !cli)) return keywordTagger;
  return claudeTagger();
}

/** Full mining over in-memory disputes. */
export async function mineFromDisputes(disputes: MinerDispute[], tagger: Tagger = defaultTagger(), opts: MineOptions = {}): Promise<Pattern[]> {
  const groups = groupDisputes(disputes);
  const eligible = groups.filter((g) => g.disputes.length >= (opts.minGroupSize ?? DEFAULTS.minGroupSize));
  const messages = eligible.flatMap((g) => g.disputes.flatMap((d) => d.messages));
  const tags = messages.length > 0 ? await tagger(messages) : [];
  return countPatterns(groups, tags, opts);
}

// ---------- DB I/O ----------

type SqliteDb = {
  prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown };
  transaction: <T extends (...a: never[]) => unknown>(fn: T) => T;
};

function resolveDb(): SqliteDb {
  const m = dbModule as unknown as Record<string, unknown>;
  const candidate =
    (typeof m.getDb === 'function' ? (m.getDb as () => unknown)() : undefined) ??
    (typeof m.db === 'function' ? (m.db as () => unknown)() : m.db) ??
    (typeof m.default === 'function' ? (m.default as () => unknown)() : m.default);
  if (!candidate || typeof (candidate as SqliteDb).prepare !== 'function') {
    throw new Error('patterns: database handle unavailable from @/lib/db');
  }
  return candidate as SqliteDb;
}

interface DisputeDbRow {
  id: string;
  sku: string | null;
  sku_name: string | null;
  reason: string;
  source: string;
  raw_json: string;
}

export function loadDisputesForMining(db: SqliteDb = resolveDb()): MinerDispute[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.sku, s.name AS sku_name, d.reason, d.source, d.raw_json
         FROM disputes d LEFT JOIN skus s ON s.sku = d.sku
        ORDER BY d.id`,
    )
    .all() as DisputeDbRow[];
  return rows.map((r) => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(r.raw_json);
    } catch {
      raw = null;
    }
    return { id: r.id, sku: r.sku, sku_name: r.sku_name, reason: r.reason, source: r.source, messages: extractBuyerMessages(r.id, raw) };
  });
}

export function savePatterns(patterns: Pattern[], db: SqliteDb = resolveDb()): void {
  const del = db.prepare('DELETE FROM patterns');
  const ins = db.prepare(
    `INSERT INTO patterns (id, sku, reason, theme, dispute_count, matching_count, quotes_json, headline, action, includes_fixture, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    del.run();
    const used = new Set<string>();
    for (const p of patterns) {
      const id = used.has(p.id) ? `${p.id}_${nanoid(6)}` : p.id;
      used.add(id);
      ins.run(id, p.sku, p.reason, p.theme, p.dispute_count, p.matching_count, JSON.stringify(p.quotes), p.headline, p.action, p.includes_fixture ? 1 : 0, p.computed_at);
    }
  });
  tx();
}

interface PatternDbRow {
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

export function loadPatterns(db: SqliteDb = resolveDb()): Pattern[] {
  const rows = db.prepare('SELECT * FROM patterns ORDER BY matching_count DESC, headline ASC').all() as PatternDbRow[];
  return rows.map((r) => {
    let quotes: PatternQuote[] = [];
    try {
      const parsed = JSON.parse(r.quotes_json);
      if (Array.isArray(parsed)) quotes = parsed;
    } catch {
      quotes = [];
    }
    const [theme] = normalizeThemes([r.theme]);
    return {
      id: r.id,
      sku: r.sku,
      reason: r.reason,
      theme: theme ?? 'sizing',
      dispute_count: r.dispute_count,
      matching_count: r.matching_count,
      quotes,
      headline: r.headline,
      action: r.action,
      includes_fixture: r.includes_fixture === 1,
      computed_at: r.computed_at,
    };
  });
}

/** Load disputes from SQLite, mine, persist, return the patterns. */
export async function minePatterns(opts: MineOptions & { tagger?: Tagger } = {}): Promise<Pattern[]> {
  const db = resolveDb();
  const disputes = loadDisputesForMining(db);
  const patterns = await mineFromDisputes(disputes, opts.tagger ?? defaultTagger(), opts);
  savePatterns(patterns, db);
  return patterns;
}

export const recomputePatterns = minePatterns;