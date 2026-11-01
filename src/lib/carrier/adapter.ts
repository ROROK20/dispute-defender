import { fixtureCarrierProvider } from './fixture-provider';

/**
 * Carrier tracking adapter. PayPal's tracker only says SHIPPED or DELIVERED;
 * the scans (where, when, who signed) come from a carrier provider.
 *
 * The bundled provider reads data/fixtures/carrier-events.json, and every
 * event it returns is labeled "Carrier fixture" in sources, the trace and the
 * evidence PDF. A real provider (EasyPost or Shippo test mode) implements the
 * same interface and is swapped in here.
 */

export type CarrierEventStatus = 'ACCEPTED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'EXCEPTION' | string;

export interface CarrierEvent {
  event_id: string;
  status: CarrierEventStatus;
  description: string;
  time: string;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface CarrierTracking {
  /** Stable provider id, e.g. 'carrier_fixture'. */
  provider: string;
  /** Human label used in source titles, e.g. 'Carrier fixture'. */
  provider_label: string;
  /** True when the data is not from a live carrier API. */
  is_fixture: boolean;
  tracking_number: string;
  carrier: string;
  service: string | null;
  delivered: boolean;
  signature_name: string | null;
  delivery_zip: string | null;
  events: CarrierEvent[];
}

export interface CarrierProvider {
  id: string;
  label: string;
  isFixture: boolean;
  lookup(trackingNumber: string): Promise<CarrierTracking | null>;
}

let provider: CarrierProvider = fixtureCarrierProvider;

export function carrierProvider(): CarrierProvider {
  return provider;
}

/** Test hook and the swap point for a live provider. */
export function setCarrierProvider(next: CarrierProvider): void {
  provider = next;
}

/** Scans for a tracking number, oldest first, or null when the provider has none. */
export async function getCarrierTracking(trackingNumber: string): Promise<CarrierTracking | null> {
  const id = trackingNumber.trim();
  if (!id) return null;
  const result = await provider.lookup(id);
  if (!result) return null;
  const events = [...result.events].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { ...result, events };
}
