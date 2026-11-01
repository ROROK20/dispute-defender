import type { EvidenceType } from './evidence-rules';

/** PayPal's documented per-file limit for dispute evidence. */
export const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 2000;

export interface TrackingInfo {
  carrier_name: string;
  tracking_number: string;
}

export interface EvidenceInput {
  evidence_type: EvidenceType;
  notes?: string;
  evidence_info?: { tracking_info?: TrackingInfo[] };
}

export interface ProvideEvidencePayload {
  evidences: (EvidenceInput & { documents: { name: string }[] })[];
}

export function evidenceFilename(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return `evidence-${safe}.pdf`;
}

/** The JSON that goes in the `input` part. Every evidence item references the attached PDF. */
export function buildProvideEvidenceInput(evidences: readonly EvidenceInput[], filename: string): ProvideEvidencePayload {
  if (evidences.length === 0) throw new Error('provide-evidence requires at least one evidence item');
  return {
    evidences: evidences.map((ev) => {
      const item: EvidenceInput & { documents: { name: string }[] } = {
        evidence_type: ev.evidence_type,
        documents: [{ name: filename }],
      };
      if (ev.notes && ev.notes.trim()) item.notes = ev.notes.trim().slice(0, 2000);
      const tracking = ev.evidence_info?.tracking_info?.filter((t) => t.tracking_number && t.carrier_name);
      if (tracking && tracking.length > 0) item.evidence_info = { tracking_info: tracking };
      return item;
    }),
  };
}

function toBlob(bytes: Uint8Array | ArrayBuffer, type: string): Blob {
  const copy = bytes instanceof ArrayBuffer ? new Uint8Array(bytes.slice(0)) : new Uint8Array(bytes);
  return new Blob([copy], { type });
}

export interface ProvideEvidenceFormArgs {
  evidences: readonly EvidenceInput[];
  pdf: Uint8Array | ArrayBuffer;
  filename: string;
}

/**
 * multipart/form-data for POST /v1/customer/disputes/{id}/provide-evidence:
 *   part `input` (application/json) + part `file1` (application/pdf).
 * fetch sets the boundary header itself; callers must not set Content-Type.
 */
export function buildProvideEvidenceForm({ evidences, pdf, filename }: ProvideEvidenceFormArgs): FormData {
  const size = pdf instanceof ArrayBuffer ? pdf.byteLength : pdf.byteLength;
  if (size === 0) throw new Error('Evidence PDF is empty');
  if (size > MAX_EVIDENCE_BYTES) throw new Error(`Evidence PDF is ${size} bytes; limit is ${MAX_EVIDENCE_BYTES}`);
  if (!filename.toLowerCase().endsWith('.pdf')) throw new Error('Evidence filename must end in .pdf');

  const form = new FormData();
  const input = buildProvideEvidenceInput(evidences, filename);
  form.append('input', toBlob(new TextEncoder().encode(JSON.stringify(input)), 'application/json'));
  form.append('file1', toBlob(pdf, 'application/pdf'), filename);
  return form;
}

/** multipart/form-data for POST /v1/customer/disputes/{id}/send-message. */
export function buildSendMessageForm(message: string): FormData {
  const text = message.trim();
  if (!text) throw new Error('Message is empty');
  if (text.length > MAX_MESSAGE_CHARS) throw new Error(`Message exceeds ${MAX_MESSAGE_CHARS} characters`);
  const form = new FormData();
  form.append('input', toBlob(new TextEncoder().encode(JSON.stringify({ message: text })), 'application/json'));
  return form;
}

/** Reads the JSON `input` part back out of a form (used by the mock adapter and tests). */
export async function readInputPart<T = unknown>(form: FormData): Promise<T | null> {
  const part = form.get('input');
  if (part === null) return null;
  try {
    const text = typeof part === 'string' ? part : await part.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}