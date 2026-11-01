import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { EvidencePacket, type EvidencePacketData } from './EvidencePacket';

export type { EvidencePacketData, PacketSentence, PacketSource, PacketTimelineItem } from './EvidencePacket';

/** PayPal's documented per-file limit for provide-evidence. */
export const MAX_EVIDENCE_PDF_BYTES = 10 * 1024 * 1024;
/** Our own target, so a packet never gets near the PayPal limit. */
export const TARGET_EVIDENCE_PDF_BYTES = 500 * 1024;

export class EvidencePdfError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'EvidencePdfError';
  }
}

export interface RenderedEvidencePdf {
  buffer: Buffer;
  bytes: number;
  filename: string;
  over_target: boolean;
}

export function evidenceFilename(disputeId: string): string {
  return `evidence-${disputeId.replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
}

function validate(data: EvidencePacketData): void {
  if (!data?.dispute?.id) throw new EvidencePdfError('Packet data is missing dispute.id');
  if (!data.run_id) throw new EvidencePdfError('Packet data is missing run_id');
  if (!Array.isArray(data.sentences) || !Array.isArray(data.sources)) {
    throw new EvidencePdfError('Packet data needs sentences[] and sources[]');
  }
  const known = new Set(data.sources.map((s) => s.source_key));
  for (const s of data.sentences) {
    if (!Array.isArray(s.source_ids) || s.source_ids.length === 0) {
      throw new EvidencePdfError(`Sentence ${s.id} has no citation; only checked sentences may be rendered`);
    }
    const missing = s.source_ids.filter((k) => !known.has(k));
    if (missing.length > 0) {
      throw new EvidencePdfError(`Sentence ${s.id} cites unknown source(s): ${missing.join(', ')}`);
    }
  }
}

/**
 * Renders the evidence packet. Deterministic for the same input, so the bytes
 * previewed at /api/disputes/:id/pdf are the bytes submitted.
 */
export async function renderEvidencePdf(data: EvidencePacketData): Promise<RenderedEvidencePdf> {
  validate(data);
  let buffer: Buffer;
  try {
    const element = React.createElement(EvidencePacket, { data }) as unknown as Parameters<typeof renderToBuffer>[0];
    buffer = await renderToBuffer(element);
  } catch (err) {
    throw new EvidencePdfError(`PDF render failed: ${(err as Error).message}`, err);
  }
  if (buffer.byteLength > MAX_EVIDENCE_PDF_BYTES) {
    throw new EvidencePdfError(`Evidence PDF is ${buffer.byteLength} bytes, over the 10 MB PayPal limit`);
  }
  return {
    buffer,
    bytes: buffer.byteLength,
    filename: evidenceFilename(data.dispute.id),
    over_target: buffer.byteLength > TARGET_EVIDENCE_PDF_BYTES,
  };
}

/** Convenience alias returning only the bytes. */
export async function renderEvidencePacket(data: EvidencePacketData): Promise<Buffer> {
  return (await renderEvidencePdf(data)).buffer;
}