import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CarrierEvent, CarrierProvider, CarrierTracking } from './adapter';

/**
 * Reads carrier scans from data/fixtures/carrier-events.json. These are not
 * live carrier data: every result is flagged `is_fixture` and labeled
 * "Carrier fixture" wherever it is shown.
 */

interface FixtureTracker {
  carrier?: string;
  service?: string | null;
  delivered?: boolean;
  signature_name?: string | null;
  delivery_zip?: string | null;
  events?: CarrierEvent[];
}

interface FixtureFile {
  trackers?: Record<string, FixtureTracker>;
}

const FIXTURE_FILE = path.join(process.cwd(), 'data', 'fixtures', 'carrier-events.json');

let cache: FixtureFile | null = null;

async function load(): Promise<FixtureFile> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FIXTURE_FILE, 'utf8')) as FixtureFile;
  } catch (err) {
    console.error('[carrier] could not read carrier fixture:', (err as Error).message);
    cache = { trackers: {} };
  }
  return cache;
}

export const fixtureCarrierProvider: CarrierProvider = {
  id: 'carrier_fixture',
  label: 'Carrier fixture',
  isFixture: true,
  async lookup(trackingNumber: string): Promise<CarrierTracking | null> {
    const file = await load();
    const t = file.trackers?.[trackingNumber];
    if (!t) return null;
    const events = (t.events ?? []).filter((e) => e && e.event_id && e.status && e.time);
    return {
      provider: 'carrier_fixture',
      provider_label: 'Carrier fixture',
      is_fixture: true,
      tracking_number: trackingNumber,
      carrier: t.carrier ?? 'OTHER',
      service: t.service ?? null,
      delivered: Boolean(t.delivered) || events.some((e) => e.status === 'DELIVERED'),
      signature_name: t.signature_name ?? null,
      delivery_zip: t.delivery_zip ?? null,
      events,
    };
  },
};
