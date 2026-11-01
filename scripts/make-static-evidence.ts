/**
 * Writes data/static-evidence.pdf: a small, hand-built PDF used for the first
 * provide-evidence milestone (before any AI exists). No dependencies: the PDF
 * objects and xref table are assembled byte by byte.
 *
 * Usage: tsx scripts/make-static-evidence.ts [--dispute PP-D-XXXX] [--out path]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Line = { text: string; size: number; bold?: boolean; gapBefore?: number };

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pdfEscape(s: string): string {
  // Keep to printable ASCII so byte offsets equal string lengths.
  const ascii = s.replace(/[^\x20-\x7E]/g, '-');
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max) {
      if (cur) out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out;
}

function buildLines(disputeId: string | undefined, generatedAt: string): Line[] {
  const lines: Line[] = [
    { text: 'Juniper Thread Co.', size: 20, bold: true },
    { text: 'Seller evidence packet', size: 13, gapBefore: 6 },
    { text: `Dispute: ${disputeId ?? 'see the PayPal case this document is attached to'}`, size: 10, gapBefore: 14 },
    { text: `Generated: ${generatedAt}`, size: 10 },
    { text: 'Sandbox demo data. Juniper Thread Co. is a fictional store.', size: 9 },
  ];
  const sections: { heading: string; body: string }[] = [
    {
      heading: 'Purpose',
      body: 'This document accompanies evidence submitted through the PayPal Disputes API provide-evidence endpoint. It is a static packet used to verify the submission path; it makes no claim about a specific order beyond what is attached in the same submission.',
    },
    {
      heading: 'Shipping and tracking',
      body: 'Our published shipping policy (published 2026-01-15) states that all orders ship with USPS and include a tracking number, which we add to the PayPal transaction when the label is created. Where tracking applies, it is supplied in the evidence_info field of this submission and can be verified with the carrier.',
    },
    {
      heading: 'Returns policy',
      body: 'Our published returns policy (published 2026-01-15) allows returns within 30 days of delivery. Items not as described receive a prepaid return label and a full refund including original shipping. Fit issues qualify for a free size exchange.',
    },
    {
      heading: 'Contact',
      body: 'We reply to every buyer message within 48 hours and are glad to resolve this directly with the buyer.',
    },
  ];
  for (const s of sections) {
    lines.push({ text: s.heading, size: 12, bold: true, gapBefore: 16 });
    for (const l of wrap(s.body, 88)) lines.push({ text: l, size: 10, gapBefore: 2 });
  }
  return lines;
}

export function buildPdf(lines: Line[]): Buffer {
  let y = 740;
  const ops: string[] = [];
  for (const l of lines) {
    y -= (l.gapBefore ?? 0) + l.size + 3;
    if (y < 60) break;
    ops.push(`BT /${l.bold ? 'F2' : 'F1'} ${l.size} Tf 72 ${y} Td (${pdfEscape(l.text)}) Tj ET`);
  }
  // Accent rule under the title block.
  ops.push('0.059 0.463 0.431 RG 1.5 w 72 680 m 540 680 l S');
  const stream = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function main(): void {
  const disputeId = argValue('--dispute');
  const outPath = path.resolve(process.cwd(), argValue('--out') ?? 'data/static-evidence.pdf');
  const pdf = buildPdf(buildLines(disputeId, new Date().toISOString()));
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, pdf);
  } catch (err) {
    console.error(`Could not write ${outPath}: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`Wrote ${outPath} (${pdf.length} bytes)`);
}

main();