import fs from 'node:fs';
import path from 'node:path';

/**
 * Mock mode only (PAYPAL_MOCK=1): keeps fixture dates current.
 *
 * The mock PayPal, carrier and dispute-history fixtures are written around a
 * fixed "fixture today", FIXTURE_TODAY. Without help, a demo seeded weeks later
 * shows stale dates. So every fixture date moves forward by the whole number of
 * days from FIXTURE_TODAY to the day the database was seeded. Open disputes then
 * show real-looking deadlines, and resolved ones stay in the past.
 *
 * One offset, in whole days, moves everything together: date-only strings
 * ("2026-10-09"), the date part of timestamps, and dates written in a buyer's
 * message ("October 8"). A date therefore reads the same in every source the
 * agent cites, and the citation checker sees one consistent world.
 *
 * The offset is pinned when the database is seeded (scripts/setup.ts writes
 * `<DATABASE_PATH>.fixture-clock.json`), so the setup process and the server
 * agree even across midnight. Store policies are not shifted. They are dated
 * long before any order, as a real store's would be.
 *
 * Real PayPal mode never shifts anything.
 */

/** The day the fixtures were written around. */
export const FIXTURE_TODAY = '2026-10-26';

const DAY_MS = 86_400_000;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PROSE = new RegExp(`\\b(${MONTHS.join('|')}) (\\d{1,2})\\b`, 'g');

/** Whole UTC days from FIXTURE_TODAY to `now`'s UTC date (never negative). */
export function shiftDaysFor(now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - Date.parse(`${FIXTURE_TODAY}T00:00:00Z`)) / DAY_MS));
}

/** Move an ISO date or timestamp by whole days; the time of day and zone are kept. Other strings are returned as they are. */
export function shiftIso(value: string, days: number): string {
  const m = ISO.exec(value);
  if (!m || days === 0) return value;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return `${d.toISOString().slice(0, 10)}${m[4] ?? ''}`;
}

/** Move "October 8"-style dates in free text by whole days (the fixture year is assumed). */
export function shiftProseDates(text: string, days: number, year = Number(FIXTURE_TODAY.slice(0, 4))): string {
  if (days === 0) return text;
  return text.replace(PROSE, (_all, month: string, day: string) => {
    const d = new Date(Date.UTC(year, MONTHS.indexOf(month), Number(day) + days));
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  });
}

/** Deep copy of a fixture with every ISO date moved by `days`; message `content` gets the prose shift. */
export function shiftFixture<T>(value: T, days: number): T {
  if (days === 0) return value;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') return key === 'content' ? shiftProseDates(v, days) : shiftIso(v, days);
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, '') as T;
}

/** Where the offset is pinned for a database file (null for in-memory databases). */
export function clockFileFor(dbPath: string | undefined): string | null {
  const p = dbPath ?? './data/app.db';
  if (p === ':memory:' || p.startsWith('file::memory:')) return null;
  return `${path.resolve(process.cwd(), p)}.fixture-clock.json`;
}

/**
 * Pin the offset for a database at seed time. An existing pin is kept. A
 * database that already held fixture history from before this clock existed
 * is pinned to 0, so its stored dates and the mock's stay in step. Returns 0
 * outside mock mode.
 */
export function pinFixtureShift(dbPath: string | undefined, freshDatabase: boolean, now = new Date()): number {
  if (process.env.PAYPAL_MOCK !== '1') return 0;
  const file = clockFileFor(dbPath);
  const days = freshDatabase ? shiftDaysFor(now) : 0;
  if (!file) return days;
  if (fs.existsSync(file)) {
    const pinned = readPin(file);
    if (pinned !== null) return pinned;
  }
  fs.writeFileSync(file, `${JSON.stringify({ fixture_today: FIXTURE_TODAY, shift_days: days, pinned_at: now.toISOString() }, null, 2)}\n`);
  cached = days;
  return days;
}

function readPin(file: string): number | null {
  try {
    const n = (JSON.parse(fs.readFileSync(file, 'utf8')) as { shift_days?: unknown }).shift_days;
    return Number.isInteger(n) ? (n as number) : null;
  } catch {
    return null;
  }
}

let cached: number | null = null;

/**
 * The offset to apply to fixtures in this process. It is 0 unless
 * PAYPAL_MOCK=1. Otherwise it is FIXTURE_SHIFT_DAYS if that is set, else the
 * pin for DATABASE_PATH, else today's offset. Computed once per process, so it
 * never drifts mid-run.
 */
export function fixtureShiftDays(): number {
  if (process.env.PAYPAL_MOCK !== '1') return 0;
  if (cached !== null) return cached;
  const override = process.env.FIXTURE_SHIFT_DAYS;
  if (override !== undefined && override.trim() !== '' && Number.isInteger(Number(override))) {
    cached = Number(override);
    return cached;
  }
  const file = clockFileFor(process.env.DATABASE_PATH);
  const pinned = file && fs.existsSync(file) ? readPin(file) : null;
  cached = pinned ?? shiftDaysFor(new Date());
  return cached;
}
