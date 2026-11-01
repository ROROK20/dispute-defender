/**
 * Deterministic citation checker (ARCHITECTURE §6.6). Pure: no I/O, no model.
 *
 * Every sentence must cite at least one source, every cited source must exist
 * in this run, and every grounded token in the sentence (numbers and money,
 * dates, tracking-like ids, double-quoted strings) must appear in the content
 * of at least one of the sources it cites, compared after normalizing case and
 * whitespace. A sentence that fails is repaired by the model or removed; it is
 * never submitted.
 */

export type CitationFailureReason = 'NO_CITATION' | 'UNKNOWN_SOURCE' | 'UNGROUNDED_TOKEN';

export interface CitedSentence {
  id: string;
  text: string;
  source_ids: string[];
}

export interface CitationFailure {
  id: string;
  text: string;
  source_ids: string[];
  reason: CitationFailureReason;
  /** The first token that could not be grounded (UNGROUNDED_TOKEN), or the unknown source id. */
  token?: string;
  /** One readable line, sent back to the model in a repair round. */
  detail: string;
}

export interface CitationCheckResult<T extends CitedSentence> {
  passed: T[];
  failed: CitationFailure[];
}

export interface CitableSource {
  content: string;
}

export type GroundedTokenKind = 'quote' | 'date' | 'tracking' | 'number';

export interface GroundedToken {
  kind: GroundedTokenKind;
  /** Exactly as written in the sentence. */
  raw: string;
  /** Comparison key: normalized text, ISO date key, or numeric value. */
  key: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_PATTERN =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const QUOTE_RE = /["“]([^"“”]{1,400})["”]/g;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const MONTH_DAY_RE = new RegExp(`\\b${MONTH_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_PATTERN}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
/** Uppercase/digit runs of 10+ characters with at least one digit: tracking numbers, capture and order ids. */
const TRACKING_RE = /\b(?=[A-Z0-9]*\d)[A-Z0-9]{10,}\b/g;
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?%?/g;
const CONTENT_NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

export function normalizeText(text: string): string {
  return text
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

/** "YYYY-MM-DD" when the year is known, "--MM-DD" otherwise. */
function dateKey(year: string | undefined, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year ? `${year}-${pad2(month)}-${pad2(day)}` : `--${pad2(month)}-${pad2(day)}`;
}

interface Span {
  start: number;
  end: number;
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

function collectDates(text: string, spans: Span[]): GroundedToken[] {
  const out: GroundedToken[] = [];
  const push = (raw: string, index: number, key: string | null) => {
    if (!key || overlaps(spans, index, index + raw.length)) return;
    spans.push({ start: index, end: index + raw.length });
    out.push({ kind: 'date', raw, key });
  };
  for (const m of text.matchAll(ISO_DATE_RE)) {
    push(m[0], m.index ?? 0, dateKey(m[1], Number(m[2]), Number(m[3])));
  }
  for (const m of text.matchAll(MONTH_DAY_RE)) {
    const month = monthNumber(m[1]);
    push(m[0], m.index ?? 0, month ? dateKey(m[3], month, Number(m[2])) : null);
  }
  for (const m of text.matchAll(DAY_MONTH_RE)) {
    const month = monthNumber(m[2]);
    push(m[0], m.index ?? 0, month ? dateKey(m[3], month, Number(m[1])) : null);
  }
  return out;
}

function numericKey(raw: string): string | null {
  const n = Number(raw.replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? String(n) : null;
}

/** Every token in a sentence that must be grounded in a cited source. */
export function extractGroundedTokens(text: string): GroundedToken[] {
  const spans: Span[] = [];
  const tokens: GroundedToken[] = [];

  for (const m of text.matchAll(QUOTE_RE)) {
    const inner = m[1].trim().replace(/[.,;:!?]+$/, '').trim();
    const start = m.index ?? 0;
    spans.push({ start, end: start + m[0].length });
    if (inner) tokens.push({ kind: 'quote', raw: m[0], key: normalizeText(inner) });
  }

  tokens.push(...collectDates(text, spans));

  for (const m of text.matchAll(TRACKING_RE)) {
    const start = m.index ?? 0;
    if (overlaps(spans, start, start + m[0].length)) continue;
    spans.push({ start, end: start + m[0].length });
    tokens.push({ kind: 'tracking', raw: m[0], key: m[0].toLowerCase() });
  }

  for (const m of text.matchAll(NUMBER_RE)) {
    const start = m.index ?? 0;
    if (overlaps(spans, start, start + m[0].length)) continue;
    const key = numericKey(m[0]);
    if (key) tokens.push({ kind: 'number', raw: m[0], key });
  }

  return tokens;
}

interface SourceIndex {
  text: string;
  dates: Set<string>;
  numbers: Set<string>;
}

function indexSource(content: string): SourceIndex {
  const text = normalizeText(content);
  const dates = new Set<string>();
  for (const t of collectDates(content, [])) {
    dates.add(t.key);
    if (!t.key.startsWith('--')) dates.add(`--${t.key.slice(5)}`);
  }
  const numbers = new Set<string>();
  for (const m of content.matchAll(CONTENT_NUMBER_RE)) {
    const key = numericKey(m[0]);
    if (key) numbers.add(key);
  }
  return { text, dates, numbers };
}

function grounded(token: GroundedToken, src: SourceIndex): boolean {
  switch (token.kind) {
    case 'quote':
      return src.text.includes(token.key);
    case 'tracking':
      return src.text.includes(token.key);
    case 'date':
      if (src.dates.has(token.key)) return true;
      // A dated sentence may cite a source that gives only the month and day.
      return !token.key.startsWith('--') && src.dates.has(`--${token.key.slice(5)}`);
    case 'number':
      return src.numbers.has(token.key);
  }
}

function describe(reason: CitationFailureReason, token?: string): string {
  if (reason === 'NO_CITATION') return 'The sentence cites no source.';
  if (reason === 'UNKNOWN_SOURCE') return `The sentence cites ${token}, which is not a source in this run.`;
  return `${token} does not appear in any source the sentence cites.`;
}

export function checkSentences<T extends CitedSentence>(
  sentences: T[],
  sourcesByKey: Record<string, CitableSource>,
): CitationCheckResult<T> {
  const indexCache = new Map<string, SourceIndex>();
  const indexOf = (key: string): SourceIndex => {
    let idx = indexCache.get(key);
    if (!idx) {
      idx = indexSource(sourcesByKey[key].content ?? '');
      indexCache.set(key, idx);
    }
    return idx;
  };

  const passed: T[] = [];
  const failed: CitationFailure[] = [];
  const fail = (s: T, reason: CitationFailureReason, token?: string) =>
    failed.push({
      id: s.id,
      text: s.text,
      source_ids: [...(s.source_ids ?? [])],
      reason,
      ...(token !== undefined ? { token } : {}),
      detail: describe(reason, token),
    });

  for (const s of sentences) {
    const ids = Array.from(new Set((s.source_ids ?? []).filter((x) => typeof x === 'string' && x.trim())));
    if (ids.length === 0) {
      fail(s, 'NO_CITATION');
      continue;
    }
    const unknown = ids.find((id) => !Object.prototype.hasOwnProperty.call(sourcesByKey, id));
    if (unknown) {
      fail(s, 'UNKNOWN_SOURCE', unknown);
      continue;
    }
    const cited = ids.map(indexOf);
    const missing = extractGroundedTokens(s.text).find((t) => !cited.some((src) => grounded(t, src)));
    if (missing) {
      fail(s, 'UNGROUNDED_TOKEN', missing.raw);
      continue;
    }
    passed.push(s);
  }

  return { passed, failed };
}
