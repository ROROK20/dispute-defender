import React from 'react';
import { Document, Page, Text, View } from '@react-pdf/renderer';
import { styles } from './styles';

export type PacketSourceKind =
  | 'dispute_field'
  | 'order_field'
  | 'capture_field'
  | 'tracking_event'
  | 'buyer_message'
  | 'seller_message'
  | 'policy_clause'
  | 'sku_field';

export interface PacketSource {
  source_key: string;
  kind: PacketSourceKind | string;
  title: string;
  content: string;
  ref?: string | null;
  fetched_at: string;
}

export interface PacketSentence {
  id: string;
  text: string;
  source_ids: string[];
}

export interface PacketTimelineItem {
  at: string;
  label: string;
  source_ids?: string[];
}

export interface EvidencePacketData {
  seller: { name: string; email?: string | null; website?: string | null };
  dispute: {
    id: string;
    reason: string;
    stage?: string | null;
    amount_cents: number;
    currency: string;
    seller_response_due_at?: string | null;
    capture_id?: string | null;
    order_id?: string | null;
    sku?: string | null;
    sku_name?: string | null;
    buyer_name?: string | null;
  };
  run_id: string;
  generated_at: string;
  sentences: PacketSentence[];
  sources: PacketSource[];
  timeline?: PacketTimelineItem[];
  tracking?: { carrier?: string | null; tracking_number?: string | null; status?: string | null } | null;
  sandbox?: boolean;
}

const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'Item not received',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'Item not as described',
  UNAUTHORISED: 'Unauthorised transaction',
};

export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function formatMoney(cents: number, currency: string): string {
  const value = (cents / 100).toFixed(2);
  return currency === 'USD' ? `$${value} USD` : `${value} ${currency}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

/** Replaces characters outside the built-in Helvetica (WinAnsi) range. */
export function pdfSafe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00A0/g, ' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A1-\u00FF]/g, '');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Assigns footnote numbers to sources in order of first citation in the letter,
 * so footnote [1] is the first source the reader meets.
 */
export function buildFootnotes(sentences: PacketSentence[], sources: PacketSource[]): { numberByKey: Map<string, number>; ordered: PacketSource[] } {
  const byKey = new Map(sources.map((s) => [s.source_key, s]));
  const numberByKey = new Map<string, number>();
  const ordered: PacketSource[] = [];
  for (const s of sentences) {
    for (const key of s.source_ids) {
      const src = byKey.get(key);
      if (src && !numberByKey.has(key)) {
        numberByKey.set(key, ordered.length + 1);
        ordered.push(src);
      }
    }
  }
  return { numberByKey, ordered };
}

function deriveTimeline(data: EvidencePacketData): PacketTimelineItem[] {
  if (data.timeline && data.timeline.length > 0) return data.timeline;
  const items: PacketTimelineItem[] = [];
  for (const s of data.sources) {
    if (s.kind === 'tracking_event' || s.kind === 'buyer_message' || s.kind === 'seller_message') {
      const match = s.content.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?/);
      if (match) items.push({ at: match[0], label: s.title, source_ids: [s.source_key] });
    }
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

function Cites({ ids, numberByKey }: { ids: string[] | undefined; numberByKey: Map<string, number> }) {
  const nums = (ids ?? []).map((k) => numberByKey.get(k)).filter((n): n is number => typeof n === 'number');
  if (nums.length === 0) return null;
  return <Text style={styles.sup}> [{nums.join(',')}]</Text>;
}

function PageChrome({ data }: { data: EvidencePacketData }) {
  return (
    <>
      <View style={styles.header} fixed>
        <View>
          <Text style={styles.brand}>{pdfSafe(data.seller.name)}</Text>
          <Text style={styles.brandSub}>Seller evidence packet</Text>
        </View>
        <View>
          <Text style={styles.headerRight}>Dispute {data.dispute.id}</Text>
          <Text style={styles.headerRight}>Case value {formatMoney(data.dispute.amount_cents, data.dispute.currency)}</Text>
        </View>
      </View>
      <View style={styles.footer} fixed>
        <Text>
          Generated {formatDate(data.generated_at)} - run {data.run_id}
          {data.sandbox ? ' - PayPal sandbox' : ''}
        </Text>
        <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
      </View>
    </>
  );
}

export function EvidencePacket({ data }: { data: EvidencePacketData }) {
  const { numberByKey, ordered } = buildFootnotes(data.sentences, data.sources);
  const timeline = deriveTimeline(data);
  const trackingSources = data.sources.filter((s) => s.kind === 'tracking_event');
  const messageSources = data.sources.filter((s) => s.kind === 'buyer_message' || s.kind === 'seller_message');
  const policySources = data.sources.filter((s) => s.kind === 'policy_clause' && numberByKey.has(s.source_key));
  const citedMessages = messageSources.filter((s) => numberByKey.has(s.source_key));
  const messagesToShow = (citedMessages.length > 0 ? citedMessages : messageSources).slice(0, 6);
  const d = data.dispute;
  // react-pdf defaults CreationDate to the wall clock and pdfkit hashes it into the file ID.
  // Pinning both to generated_at keeps the rendered bytes identical for identical input.
  const generatedAt = new Date(data.generated_at);

  return (
    <Document
      title={`Evidence for dispute ${d.id}`}
      author={pdfSafe(data.seller.name)}
      subject={`${reasonLabel(d.reason)} - ${d.id}`}
      creator="DisputeDefender"
      producer="DisputeDefender"
      creationDate={generatedAt}
      modificationDate={generatedAt}
    >
      <Page size="LETTER" style={styles.page}>
        <PageChrome data={data} />

        <Text style={styles.title}>Response to dispute {d.id}</Text>
        <Text style={styles.subtitle}>
          {reasonLabel(d.reason)}
          {d.stage ? ` - ${d.stage}` : ''}
        </Text>

        <View style={styles.factGrid}>
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Disputed amount</Text>
            <Text style={styles.factValue}>{formatMoney(d.amount_cents, d.currency)}</Text>
          </View>
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Response due</Text>
            <Text style={styles.factValue}>{formatDate(d.seller_response_due_at)}</Text>
          </View>
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Transaction (capture)</Text>
            <Text style={styles.factValue}>{d.capture_id ?? '-'}</Text>
          </View>
          <View style={styles.fact}>
            <Text style={styles.factLabel}>Order</Text>
            <Text style={styles.factValue}>{d.order_id ?? '-'}</Text>
          </View>
          {d.sku ? (
            <View style={styles.fact}>
              <Text style={styles.factLabel}>Item</Text>
              <Text style={styles.factValue}>{pdfSafe(d.sku_name ? `${d.sku_name} (${d.sku})` : d.sku)}</Text>
            </View>
          ) : null}
          {data.tracking?.tracking_number ? (
            <View style={styles.fact}>
              <Text style={styles.factLabel}>Tracking</Text>
              <Text style={styles.factValue}>
                {pdfSafe(`${data.tracking.carrier ?? ''} ${data.tracking.tracking_number}`.trim())}
                {data.tracking.status ? ` - ${data.tracking.status}` : ''}
              </Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.h2}>Statement</Text>
        {data.sentences.length === 0 ? (
          <Text style={styles.paragraph}>No supported statements were produced for this dispute.</Text>
        ) : (
          data.sentences.map((s) => (
            <Text key={s.id} style={styles.sentence}>
              {pdfSafe(s.text)}
              <Cites ids={s.source_ids} numberByKey={numberByKey} />
            </Text>
          ))
        )}
        <View style={styles.signature}>
          <Text>{pdfSafe(data.seller.name)}</Text>
          {data.seller.email ? <Text style={styles.footnoteMeta}>{pdfSafe(data.seller.email)}</Text> : null}
          {data.seller.website ? <Text style={styles.footnoteMeta}>{pdfSafe(data.seller.website)}</Text> : null}
        </View>

        {timeline.length > 0 ? (
          <View wrap={false}>
            <Text style={styles.h2}>Timeline</Text>
            <View style={styles.tableRow}>
              <Text style={[styles.colWhen, styles.tableHead]}>When</Text>
              <Text style={[styles.colWhat, styles.tableHead]}>Event</Text>
              <Text style={[styles.colRef, styles.tableHead]}>Ref</Text>
            </View>
            {timeline.slice(0, 14).map((t, i) => (
              <View key={`${t.at}-${i}`} style={styles.tableRow}>
                <Text style={styles.colWhen}>{formatDate(t.at)}</Text>
                <Text style={styles.colWhat}>{pdfSafe(truncate(t.label, 140))}</Text>
                <Text style={styles.colRef}>
                  {(t.source_ids ?? [])
                    .map((k) => numberByKey.get(k))
                    .filter((n): n is number => typeof n === 'number')
                    .map((n) => `[${n}]`)
                    .join(' ')}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {trackingSources.length > 0 ? (
          <View>
            <Text style={styles.h2}>Tracking proof</Text>
            {trackingSources.slice(0, 8).map((s) => (
              <View key={s.source_key} style={styles.quote} wrap={false}>
                <Text style={styles.quoteMeta}>
                  {pdfSafe(s.title)}
                  {numberByKey.has(s.source_key) ? ` [${numberByKey.get(s.source_key)}]` : ''}
                </Text>
                <Text style={styles.mono}>{pdfSafe(truncate(s.content, 600))}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {messagesToShow.length > 0 ? (
          <View>
            <Text style={styles.h2}>Message excerpt</Text>
            {messagesToShow.map((s) => (
              <View key={s.source_key} style={styles.quote} wrap={false}>
                <Text style={styles.quoteMeta}>
                  {pdfSafe(s.title)}
                  {numberByKey.has(s.source_key) ? ` [${numberByKey.get(s.source_key)}]` : ''}
                </Text>
                <Text>{pdfSafe(truncate(s.content, 700))}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {policySources.length > 0 ? (
          <View>
            <Text style={styles.h2}>Policy clause</Text>
            {policySources.map((s) => (
              <View key={s.source_key} style={styles.quote} wrap={false}>
                <Text style={styles.quoteMeta}>
                  {pdfSafe(s.title)} [{numberByKey.get(s.source_key)}]
                </Text>
                <Text>{pdfSafe(truncate(s.content, 900))}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {ordered.length > 0 ? (
          <View>
            <Text style={styles.h2}>Sources</Text>
            {ordered.map((s, i) => (
              <Text key={s.source_key} style={styles.footnote}>
                <Text style={styles.footnoteKey}>[{i + 1}] </Text>
                {pdfSafe(s.title)}
                <Text style={styles.footnoteMeta}>
                  {' '}
                  - {s.kind.replace(/_/g, ' ')}
                  {s.ref ? `, ${pdfSafe(s.ref)}` : ''}, retrieved {formatDate(s.fetched_at)} ({s.source_key})
                </Text>
              </Text>
            ))}
          </View>
        ) : null}
      </Page>
    </Document>
  );
}

export default EvidencePacket;