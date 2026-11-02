import fs from 'node:fs';
import path from 'node:path';
import { parseJson } from '../db';
import { getEnv } from '../env';
import { getDispute } from '../repo/disputes';
import { getOrder, getOrderByCaptureId, type Order } from '../repo/orders';
import { getRun } from '../repo/runs';
import { getSku } from '../repo/skus';
import { listSources } from '../repo/sources';
import type { EvidencePacketData, PacketSentence } from './EvidencePacket';

/**
 * Builds the evidence-packet input for one run from the database. Both the
 * preview route (GET /api/disputes/:id/pdf) and the submission service render
 * from this function, and every field is derived from stored rows (generated_at
 * is the run's draft time, not "now"), so the previewed bytes are the bytes
 * that get submitted.
 */

interface StoreIdentity {
  name: string;
  email: string | null;
}

const FALLBACK_STORE: StoreIdentity = { name: 'Juniper Thread Co.', email: null };

function loadStoreIdentity(): StoreIdentity {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'fixtures', 'store.json'), 'utf8')) as {
      store?: { name?: unknown; support_email?: unknown };
    };
    const name = typeof raw.store?.name === 'string' && raw.store.name.trim() ? raw.store.name.trim() : FALLBACK_STORE.name;
    const email = typeof raw.store?.support_email === 'string' ? raw.store.support_email : null;
    return { name, email };
  } catch {
    return FALLBACK_STORE;
  }
}

function isSentence(value: unknown): value is PacketSentence {
  const s = value as PacketSentence;
  return (
    Boolean(s) &&
    typeof s.id === 'string' &&
    typeof s.text === 'string' &&
    Array.isArray(s.source_ids) &&
    s.source_ids.every((k) => typeof k === 'string')
  );
}

function trackingFor(order: Order | null, evidencePlanJson: string | null): EvidencePacketData['tracking'] {
  if (order?.tracking_number) {
    return { carrier: order.carrier, tracking_number: order.tracking_number, status: order.tracker_status };
  }
  const plan = parseJson<{ tracking_number?: unknown; carrier?: unknown }[]>(evidencePlanJson, []);
  const item = Array.isArray(plan) ? plan.find((p) => typeof p?.tracking_number === 'string' && p.tracking_number) : undefined;
  if (!item) return null;
  return {
    carrier: typeof item.carrier === 'string' ? item.carrier : null,
    tracking_number: item.tracking_number as string,
    status: null,
  };
}

export function loadEvidencePacket(disputeId: string, runId: string): EvidencePacketData {
  const dispute = getDispute(disputeId);
  if (!dispute) throw new Error(`Dispute ${disputeId} not found`);
  const run = getRun(runId);
  if (!run || run.dispute_id !== disputeId) throw new Error(`Run ${runId} not found for dispute ${disputeId}`);

  const draft = parseJson<{ sentences?: unknown }>(run.draft_json, {});
  const sentences = (Array.isArray(draft.sentences) ? draft.sentences : []).filter(isSentence).map((s) => ({
    id: s.id,
    text: s.text,
    source_ids: [...s.source_ids],
  }));

  const order = dispute.order_id
    ? getOrder(dispute.order_id)
    : dispute.capture_id
      ? getOrderByCaptureId(dispute.capture_id)
      : null;
  const sku = dispute.sku ? getSku(dispute.sku) : null;
  const store = loadStoreIdentity();
  const env = getEnv();

  return {
    seller: {
      name: store.name,
      email: store.email,
      website: env.PUBLIC_BASE_URL ? `${env.PUBLIC_BASE_URL}/store` : null,
    },
    dispute: {
      id: dispute.id,
      reason: dispute.reason,
      stage: dispute.stage,
      amount_cents: dispute.amount_cents,
      currency: dispute.currency,
      seller_response_due_at: dispute.seller_response_due_at,
      capture_id: dispute.capture_id ?? order?.capture_id ?? null,
      order_id: dispute.order_id ?? order?.id ?? null,
      sku: dispute.sku,
      sku_name: sku?.name ?? null,
      buyer_name: order?.buyer_name ?? null,
    },
    run_id: run.id,
    generated_at: run.draft_ready_at ?? run.clock_started_at,
    sentences,
    sources: listSources(run.id).map((s) => ({
      source_key: s.source_key,
      kind: s.kind,
      title: s.title,
      content: s.content,
      ref: s.ref,
      fetched_at: s.fetched_at,
    })),
    tracking: trackingFor(order, run.evidence_plan_json),
    sandbox: env.PAYPAL_ENV === 'sandbox',
  };
}
