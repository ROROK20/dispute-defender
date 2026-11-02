import { describe, it, expect } from 'vitest';
import {
  MAX_EVIDENCE_BYTES,
  buildProvideEvidenceForm,
  buildSendMessageForm,
  evidenceFilename,
  type EvidenceInput,
} from '../../src/lib/paypal/multipart';

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"
const FILENAME = evidenceFilename('PP-D-1234');

async function partText(form: FormData, name: string): Promise<string> {
  const v = form.get(name);
  if (v === null) throw new Error(`missing part ${name}`);
  return typeof v === 'string' ? v : await (v as Blob).text();
}

describe('buildProvideEvidenceForm', () => {
  const evidences: EvidenceInput[] = [
    {
      evidence_type: 'PROOF_OF_FULFILLMENT',
      evidence_info: { tracking_info: [{ carrier_name: 'USPS', tracking_number: '9400111899223344556677' }] },
      notes: 'Delivered 2026-10-14.',
    },
  ];

  it('names the evidence file evidence-<dispute id>.pdf', () => {
    expect(FILENAME).toBe('evidence-PP-D-1234.pdf');
  });

  it('creates an input part with application/json and the evidences array', async () => {
    const form = buildProvideEvidenceForm({ evidences, pdf: PDF, filename: FILENAME });
    const input = form.get('input');
    expect(input).not.toBeNull();
    if (typeof input !== 'string') expect((input as Blob).type).toContain('application/json');
    const json = JSON.parse(await partText(form, 'input'));
    expect(json.evidences).toHaveLength(1);
    expect(json.evidences[0].evidence_type).toBe('PROOF_OF_FULFILLMENT');
    expect(json.evidences[0].evidence_info.tracking_info[0]).toEqual({ carrier_name: 'USPS', tracking_number: '9400111899223344556677' });
    expect(json.evidences[0].notes).toBe('Delivered 2026-10-14.');
  });

  it('references the uploaded document by name in the evidence', async () => {
    const form = buildProvideEvidenceForm({ evidences, pdf: PDF, filename: FILENAME });
    const json = JSON.parse(await partText(form, 'input'));
    expect(json.evidences[0].documents).toEqual([{ name: 'evidence-PP-D-1234.pdf' }]);
  });

  it('attaches the PDF as file1 with filename and application/pdf', async () => {
    const form = buildProvideEvidenceForm({ evidences, pdf: PDF, filename: FILENAME });
    const file = form.get('file1') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('application/pdf');
    expect(file.name).toBe('evidence-PP-D-1234.pdf');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(PDF));
  });

  it('serializes to a multipart body with both parts', async () => {
    const form = buildProvideEvidenceForm({ evidences, pdf: PDF, filename: FILENAME });
    const res = new Response(form);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    const body = await res.text();
    expect(body).toContain('name="input"');
    expect(body).toContain('name="file1"; filename="evidence-PP-D-1234.pdf"');
    expect(body).toContain('Content-Type: application/pdf');
    expect(body).toContain('%PDF-1.4');
  });

  it('drops incomplete tracking entries and omits empty notes', async () => {
    const form = buildProvideEvidenceForm({
      evidences: [
        { evidence_type: 'PROOF_OF_FULFILLMENT', evidence_info: { tracking_info: [{ carrier_name: '', tracking_number: '9400' }] }, notes: '  ' },
        { evidence_type: 'OTHER', notes: 'See attached packet.' },
      ],
      pdf: PDF,
      filename: FILENAME,
    });
    const json = JSON.parse(await partText(form, 'input'));
    expect(json.evidences[0]).toEqual({ evidence_type: 'PROOF_OF_FULFILLMENT', documents: [{ name: FILENAME }] });
    expect(json.evidences[1]).toEqual({ evidence_type: 'OTHER', notes: 'See attached packet.', documents: [{ name: FILENAME }] });
  });

  it('refuses an empty, oversized or non-PDF upload, and an empty evidence list', () => {
    expect(() => buildProvideEvidenceForm({ evidences, pdf: new Uint8Array(0), filename: FILENAME })).toThrow(/empty/);
    expect(() =>
      buildProvideEvidenceForm({ evidences, pdf: new Uint8Array(MAX_EVIDENCE_BYTES + 1), filename: FILENAME }),
    ).toThrow(/limit/);
    expect(() => buildProvideEvidenceForm({ evidences, pdf: PDF, filename: 'evidence.txt' })).toThrow(/\.pdf/);
    expect(() => buildProvideEvidenceForm({ evidences: [], pdf: PDF, filename: FILENAME })).toThrow(/at least one/);
  });
});

describe('buildSendMessageForm', () => {
  it('creates an input part with the message', async () => {
    const form = buildSendMessageForm('Hello, we have shipped a replacement.');
    const json = JSON.parse(await partText(form, 'input'));
    expect(json).toEqual({ message: 'Hello, we have shipped a replacement.' });
    expect(form.get('file1')).toBeNull();
  });

  it('rejects empty and over-long messages', () => {
    expect(() => buildSendMessageForm('   ')).toThrow(/empty/);
    expect(() => buildSendMessageForm('x'.repeat(2001))).toThrow(/2000/);
  });
});
