import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURE_TODAY, pinFixtureShift, shiftDaysFor, shiftFixture, shiftIso, shiftProseDates } from '../../src/lib/fixture-clock';

const DAY = 86_400_000;
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), rel), 'utf8'));
const t = (iso: string) => Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);

type Dispute = {
  dispute_id: string;
  create_time: string;
  seller_response_due_date: string;
  disputed_transactions: { create_time: string }[];
  messages: { time_posted: string; content: string }[];
};

describe('fixture clock: helpers', () => {
  it('counts whole UTC days from the fixture day', () => {
    expect(shiftDaysFor(new Date(`${FIXTURE_TODAY}T23:59:00Z`))).toBe(0);
    expect(shiftDaysFor(new Date('2026-11-10T17:30:00Z'))).toBe(15);
    expect(shiftDaysFor(new Date('2026-01-01T00:00:00Z'))).toBe(0);
  });

  it('moves dates, timestamps and prose dates together, and leaves other strings alone', () => {
    expect(shiftIso('2026-10-09', 15)).toBe('2026-10-24');
    expect(shiftIso('2026-10-20T15:04:11.000Z', 15)).toBe('2026-11-04T15:04:11.000Z');
    expect(shiftIso('2026-12-25T08:00:00Z', 10)).toBe('2027-01-04T08:00:00Z');
    expect(shiftIso('PP-D-27811', 15)).toBe('PP-D-27811');
    expect(shiftProseDates('I paid on October 8 and still have nothing.', 15)).toBe('I paid on October 23 and still have nothing.');
    expect(shiftProseDates('Ordered October 20.', 15)).toBe('Ordered November 4.');
    const shifted = shiftFixture({ create_time: '2026-10-08T18:31:05Z', shipment_date: '2026-10-09', amount: '68.00', messages: [{ content: 'Paid October 8.' }] }, 15);
    expect(shifted).toEqual({ create_time: '2026-10-23T18:31:05Z', shipment_date: '2026-10-24', amount: '68.00', messages: [{ content: 'Paid October 23.' }] });
  });

  it('pins the offset per database at seed time, mock mode only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-clock-'));
    const db = path.join(dir, 'demo.db');
    const mock = process.env.PAYPAL_MOCK;
    try {
      process.env.PAYPAL_MOCK = '1';
      expect(pinFixtureShift(db, true, new Date('2026-11-10T12:00:00Z'))).toBe(15);
      // Re-running setup later keeps the first pin.
      expect(pinFixtureShift(db, false, new Date('2026-12-01T12:00:00Z'))).toBe(15);
      expect(JSON.parse(fs.readFileSync(`${db}.fixture-clock.json`, 'utf8')).shift_days).toBe(15);
      // A database seeded before the clock existed stays unshifted.
      expect(pinFixtureShift(path.join(dir, 'old.db'), false, new Date('2026-11-10T12:00:00Z'))).toBe(0);
      process.env.PAYPAL_MOCK = '0';
      expect(pinFixtureShift(path.join(dir, 'real.db'), true, new Date('2026-11-10T12:00:00Z'))).toBe(0);
      expect(fs.existsSync(path.join(dir, 'real.db.fixture-clock.json'))).toBe(false);
    } finally {
      process.env.PAYPAL_MOCK = mock;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fixture clock: the mock fixtures after the shift', () => {
  // Several seed days, including a month and a year boundary.
  const seedDays = ['2026-10-26T09:00:00Z', '2026-11-10T17:30:00Z', '2026-12-28T23:00:00Z', '2027-03-01T06:00:00Z'];

  for (const seed of seedDays) {
    const now = new Date(seed);
    const days = shiftDaysFor(now);

    it(`open disputes are due 3 to 13 days after seeding, with their dates in order (seeded ${seed.slice(0, 10)})`, () => {
      for (const f of ['dispute-inr.json', 'dispute-snad.json', 'dispute-unauth.json']) {
        const raw = read(`data/fixtures/mock-paypal/${f}`) as Dispute;
        const d = shiftFixture(raw, days);
        const due = t(d.seller_response_due_date);
        const created = t(d.create_time);
        const paid = t(d.disputed_transactions[0].create_time);
        const posts = d.messages.map((m) => t(m.time_posted));

        expect((due - now.getTime()) / DAY, `${f} due`).toBeGreaterThan(3);
        expect((due - now.getTime()) / DAY, `${f} due`).toBeLessThan(13);
        expect(created, `${f} opened in the past`).toBeLessThan(now.getTime());
        expect(paid).toBeLessThan(posts[0]);
        posts.forEach((p, i) => i && expect(p).toBeGreaterThanOrEqual(posts[i - 1]));
        // The dispute opens with the buyer's last message; everything happens before the deadline.
        expect(created).toBe(posts[posts.length - 1]);
        expect(Math.max(created, ...posts)).toBeLessThan(due);
        // The shift is uniform: every gap inside the dispute is unchanged.
        expect(due - created).toBe(t(raw.seller_response_due_date) - t(raw.create_time));
      }
    });

    it(`the INR buyer's "I paid on <date>" still matches the capture date (seeded ${seed.slice(0, 10)})`, () => {
      const d = shiftFixture(read('data/fixtures/mock-paypal/dispute-inr.json') as Dispute, days);
      const paid = new Date(d.disputed_transactions[0].create_time);
      const month = paid.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
      expect(d.messages[0].content).toContain(`I paid on ${month} ${paid.getUTCDate()}`);
    });

    it(`fixture history is resolved in the past and carrier scans run in order (seeded ${seed.slice(0, 10)})`, () => {
      const history = shiftFixture(read('data/fixtures/historical-disputes.json'), days) as {
        disputes: { status: string; created_at: string; updated_at: string; order: { captured_at: string } }[];
      };
      for (const h of history.disputes) {
        expect(h.status).toBe('RESOLVED');
        expect(t(h.order.captured_at)).toBeLessThan(t(h.created_at));
        expect(t(h.created_at)).toBeLessThanOrEqual(t(h.updated_at));
        expect(t(h.updated_at)).toBeLessThan(now.getTime());
      }
      const carrier = shiftFixture(read('data/fixtures/carrier-events.json'), days) as { trackers: Record<string, { events: { time: string }[] }> };
      for (const tr of Object.values(carrier.trackers)) {
        const times = tr.events.map((e) => t(e.time));
        times.forEach((x, i) => i && expect(x).toBeGreaterThan(times[i - 1]));
        expect(times[times.length - 1]).toBeLessThan(now.getTime());
      }
      // The INR shipment date and its first carrier scan agree after the shift.
      const tracker = shiftFixture(read('data/fixtures/mock-paypal/tracker.json'), days) as { shipment_date: string; tracking_number: string };
      expect(carrier.trackers[tracker.tracking_number].events[0].time.slice(0, 10)).toBe(tracker.shipment_date);
    });
  }
});
