import { z } from 'zod';
import { EVIDENCE_TYPES, type EvidenceType } from '../paypal/evidence-rules';

/**
 * The agent's terminal output, validated with zod before anything is stored
 * (ARCHITECTURE §6.6). The JSON Schemas below are what Claude sees; zod is
 * what the runner trusts.
 */

export const RECOMMENDATIONS = ['FIGHT', 'ACCEPT_CLAIM', 'MAKE_OFFER'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];

const sourceIds = z.array(z.string().trim().min(1).max(12)).max(12);

export const SentenceSchema = z.object({
  id: z.string().trim().min(1).max(24),
  text: z.string().trim().min(1).max(1200),
  source_ids: sourceIds,
});
export type Sentence = z.infer<typeof SentenceSchema>;

export const CitedTextSchema = z.object({
  text: z.string().trim().min(1).max(1200),
  source_ids: sourceIds,
});
export type CitedText = z.infer<typeof CitedTextSchema>;

export const EvidencePlanItemSchema = z.object({
  evidence_type: z.enum(EVIDENCE_TYPES),
  notes: z.string().trim().max(1000).default(''),
  tracking_number: z.string().trim().max(64).optional(),
  carrier: z.string().trim().max(64).optional(),
});
export type EvidencePlanItem = z.infer<typeof EvidencePlanItemSchema>;

export const SubmitAnalysisSchema = z
  .object({
    classification: z.object({
      reason: z.string().trim().min(1).max(80),
      sub_theme: z.string().trim().max(200).default(''),
      evidence_needed: z.array(z.string().trim().max(200)).max(12).default([]),
      confidence_note: z.string().trim().max(400).optional(),
    }),
    recommendation: z.enum(RECOMMENDATIONS),
    recommendation_rationale: z.array(CitedTextSchema).max(6).default([]),
    evidence_plan: z.array(EvidencePlanItemSchema).max(6).default([]),
    sentences: z.array(SentenceSchema).min(1).max(20),
    buyer_message: CitedTextSchema.optional(),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<string>();
    v.sentences.forEach((s, i) => {
      if (seen.has(s.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sentences', i, 'id'], message: `duplicate sentence id ${s.id}` });
      }
      seen.add(s.id);
    });
  });
export type SubmitAnalysis = z.infer<typeof SubmitAnalysisSchema>;

export const ReviseSentencesSchema = z.object({
  sentences: z.array(SentenceSchema).max(20),
});
export type ReviseSentences = z.infer<typeof ReviseSentencesSchema>;

export const ReviewSchema = z.object({
  sentences: z.array(z.object({ id: z.string().trim().min(1).max(24), text: z.string().trim().min(1).max(1200) })).max(20),
});
export type Review = z.infer<typeof ReviewSchema>;

/** Readable one-line-per-issue summary, sent back to the model on a validation failure. */
export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 12)
    .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

// ── JSON Schemas shown to Claude ─────────────────────────────────────

const SOURCE_IDS_JSON = {
  type: 'array',
  items: { type: 'string', description: 'A source key from a tool result, e.g. "S3".' },
  description: 'Source keys this text is grounded in. Every number, date, tracking number and quote in the text must appear in one of them.',
} as const;

const SENTENCE_JSON = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Short unique id: s1, s2, ...' },
    text: { type: 'string' },
    source_ids: SOURCE_IDS_JSON,
  },
  required: ['id', 'text', 'source_ids'],
} as const;

const CITED_TEXT_JSON = {
  type: 'object',
  properties: { text: { type: 'string' }, source_ids: SOURCE_IDS_JSON },
  required: ['text', 'source_ids'],
} as const;

export function submitAnalysisJsonSchema(evidenceTypes: readonly EvidenceType[] = EVIDENCE_TYPES) {
  return {
    type: 'object' as const,
    properties: {
      classification: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'The PayPal reason code of this dispute.' },
          sub_theme: { type: 'string', description: 'What the buyer is actually claiming, in a few words, e.g. "fit: runs small".' },
          evidence_needed: { type: 'array', items: { type: 'string' } },
          confidence_note: { type: 'string', description: 'What is missing or uncertain in the evidence.' },
        },
        required: ['reason', 'sub_theme', 'evidence_needed'],
      },
      recommendation: {
        type: 'string',
        enum: [...RECOMMENDATIONS],
        description: 'Use the option compute_expected_value recommends.',
      },
      recommendation_rationale: { type: 'array', items: CITED_TEXT_JSON },
      evidence_plan: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            evidence_type: { type: 'string', enum: [...evidenceTypes] },
            notes: { type: 'string' },
            tracking_number: { type: 'string', description: 'Only a tracking number that appears in a source.' },
            carrier: { type: 'string' },
          },
          required: ['evidence_type', 'notes'],
        },
      },
      sentences: {
        type: 'array',
        items: SENTENCE_JSON,
        description: 'The response letter to PayPal, one entry per sentence, each with citations.',
      },
      buyer_message: { ...CITED_TEXT_JSON, description: 'Optional short, courteous reply to the buyer.' },
    },
    required: ['classification', 'recommendation', 'recommendation_rationale', 'evidence_plan', 'sentences'],
  };
}

export const REVISE_SENTENCES_JSON_SCHEMA = {
  type: 'object' as const,
  properties: { sentences: { type: 'array', items: SENTENCE_JSON } },
  required: ['sentences'],
};

export const REVIEW_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
  },
  required: ['sentences'],
};
