import { describe, it, expect } from 'vitest';
import { buildProvideEvidenceForm, buildSendMessageForm } from '../../src/lib/paypal/multipart';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"

async function partText(form: FormData, name: string): Promise<string> {
  const v = form.get(name);
  if (v === null) throw new Error(`missing part ${name}`);
  return typeof v === 'string' ? v : await (v as Blob).text();
}

describe('buildProvideEvidenceForm', () => {
  const evidences = [
    {
      evidence_type: 'PROOF_OF_FULFILLMENT',
      evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: '9400111899223344556677' }] },
      notes: 'Delivered 2026-10-14.',
    },
  ];

  it('creates an input part with application/json and the evidences array', async () => {
    const form = buildProvideEvidenceForm({ disputeId: 'PP-D-1234', evidences, pdf: PDF });
    const input = form.get('input');
    expect(input).not.toBeNull();
    if (typeof input !== 'string') expect((input as Blob).type).toContain('application/json');
    const json = JSON.parse(await partText(form, 'input'));
    expect(json.evidences).toHaveLength(1);
    expect(json.evidences[0].evidence_type).toBe('PROOF_OF_FULFILLMENT');
    expect(json.evidences[0].evidence_info.tracking_info[0].tracking_number).toBe('9400111899223344556677');
  });

  it('references the uploaded document by name in the evidence', async () => {
    const form = buildProvideEvidenceForm({ disputeId: 'PP-D-1234', evidences, pdf: PDF });
    const json = JSON.parse(await partText(form, 'input'));
    expect(json.evidences[0].documents).toEqual([{ name: 'evidence-PP-D-1234.pdf' }]);
  });

  it('attaches the PDF as file1 with filename and application/pdf', async () => {
    const form = buildProvideEvidenceForm({ disputeId: 'PP-D-1234', evidences, pdf: PDF });
    const file = form.get('file1') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('application/pdf');
    expect(file.name).toBe('evidence-PP-D-1234.pdf');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(PDF));
  });

  it('serializes to a multipart body with both parts', async () => {
    const form = buildProvideEvidenceForm({ disputeId: 'PP-D-1234', evidences, pdf: PDF });
    const res = new Response(form);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const body = await res.text();
    expect(body).toContain('name="input"');
    expect(body).toContain('name="file1"; filename="evidence-PP-D-1234.pdf"');
    expect(body).toContain('Content-Type: application/pdf');
    expect(body).toContain('%PDF-1.4');
  });
});

describe('buildSendMessageForm', () => {
  it('creates an input part with the message', async () => {
    const form = buildSendMessageForm('Hello, we have shipped a replacement.');
    const json = JSON.parse(await partText(form, 'input'));
    expect(json).toEqual({ message: 'Hello, we have shipped a replacement.' });
    expect(form.get('file1')).toBeNull();
  });
});