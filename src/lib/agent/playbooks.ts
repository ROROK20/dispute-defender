import { allowedEvidenceTypes, type EvidenceType } from '../paypal/evidence-rules';
import { reasonGroup, type ReasonGroup } from '../scoring/strength';

/**
 * Per-reason-code playbooks: what a PayPal reviewer weighs, which tools to
 * call, how the letter is laid out, and when conceding is the honest call.
 * They steer the model; they never put facts into a letter. Every fact still
 * has to come from a tool result and pass the citation check.
 */

export type PolicySlug = 'returns' | 'shipping' | 'size-guide';

export interface Playbook {
  group: ReasonGroup;
  title: string;
  /** What a reviewer looks for, in priority order. */
  weighs: string[];
  /** Tools worth calling for this reason code, in a sensible order. */
  tools: string[];
  policies: PolicySlug[];
  evidenceTypes: readonly EvidenceType[];
  letterOutline: string[];
  concedeWhen: string[];
}

const PLAYBOOKS: Record<ReasonGroup, Omit<Playbook, 'evidenceTypes'>> = {
  INR: {
    group: 'INR',
    title: 'Item not received (MERCHANDISE_OR_SERVICE_NOT_RECEIVED)',
    weighs: [
      'Tracking attached to the PayPal transaction',
      'A carrier scan showing delivery',
      "Delivery at the ship-to address on the PayPal transaction (ZIP match)",
      'A delivery signature, which matters most on high-value orders',
      'Shipment before the buyer opened the claim',
    ],
    tools: ['get_dispute', 'get_messages', 'get_transaction', 'get_tracking', 'get_policy', 'score_evidence', 'compute_expected_value'],
    policies: ['shipping'],
    letterOutline: [
      'Identify the order: what was bought, the amount, and when it was paid.',
      'When and how it shipped: carrier and tracking number.',
      'The delivery scan: date and delivery ZIP, and that the ZIP matches the PayPal ship-to address.',
      'The signature, if the carrier captured one.',
      'The relevant shipping-policy clause, if it helps.',
      'A one-line request that the case be decided in the seller\'s favor.',
    ],
    concedeWhen: [
      'There is no tracking and no carrier scan at all.',
      'The scans show the parcel never left the origin facility, or went to a different ZIP.',
    ],
  },
  SNAD: {
    group: 'SNAD',
    title: 'Not as described (MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED)',
    weighs: [
      'The listing description of the SKU that was actually ordered',
      'A returns or size policy published before the purchase',
      'How quickly and how fairly the seller answered the buyer',
      'Whether the seller offered a return or exchange under that policy',
      'Whether this SKU has drawn the same complaint before (a pattern argues the listing is the problem)',
    ],
    tools: ['get_dispute', 'get_messages', 'get_transaction', 'get_sku', 'get_policy', 'get_tracking', 'score_evidence', 'compute_expected_value'],
    policies: ['returns', 'size-guide'],
    letterOutline: [
      'Identify the order and the listing: the SKU name and what its description says.',
      'What the buyer claims, quoted exactly from their message.',
      'What the listing and the size guide said before the purchase.',
      'How the seller responded and what remedy was offered under the returns policy.',
      'A one-line request: the seller stands by the listing and the offered return.',
    ],
    concedeWhen: [
      'The buyer\'s complaint matches a documented flaw or an earlier complaint pattern on this SKU.',
      'The seller never answered the buyer or refused the return the policy promises.',
    ],
  },
  UNAUTHORISED: {
    group: 'UNAUTHORISED',
    title: 'Unauthorised transaction (UNAUTHORISED)',
    weighs: [
      'Delivery to the ship-to address on the PayPal transaction',
      'A delivery signature',
      'Earlier undisputed orders from the same buyer account',
      'A delivered scan',
    ],
    tools: ['get_dispute', 'get_transaction', 'get_tracking', 'get_messages', 'score_evidence', 'compute_expected_value'],
    policies: ['shipping'],
    letterOutline: [
      'Identify the order and the PayPal ship-to address it was sent to.',
      'The delivery scan at that address, with date and ZIP.',
      'The signature, if any.',
      'Earlier undisputed orders from the same account, if the store has them.',
      'A one-line request for a decision in the seller\'s favor.',
    ],
    concedeWhen: [
      'The parcel was not delivered to the PayPal ship-to address.',
      'There is no delivery evidence at all.',
    ],
  },
  OTHER: {
    group: 'OTHER',
    title: 'Other reason code (generic path)',
    weighs: ['Tracking on the PayPal transaction', 'A delivered scan', 'A relevant policy published before purchase'],
    tools: ['get_dispute', 'get_messages', 'get_transaction', 'get_tracking', 'get_policy', 'score_evidence', 'compute_expected_value'],
    policies: ['returns', 'shipping'],
    letterOutline: [
      'Identify the order and the amount.',
      'The facts the sources support, one per sentence.',
      'A one-line request for review.',
    ],
    concedeWhen: ['The sources do not support the seller\'s side.'],
  },
};

export function playbookFor(reason: string): Playbook {
  const group = reasonGroup(reason);
  return { ...PLAYBOOKS[group], evidenceTypes: allowedEvidenceTypes(reason) };
}

/** Markdown block for the system prompt. */
export function renderPlaybook(p: Playbook): string {
  const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
  return [
    `PLAYBOOK: ${p.title}`,
    '',
    'What a PayPal reviewer weighs:',
    list(p.weighs),
    '',
    `Useful tools, in order: ${p.tools.join(', ')}. Policies worth reading: ${p.policies.join(', ')}.`,
    `Evidence types PayPal accepts for this reason code: ${p.evidenceTypes.join(', ')}.`,
    '',
    'Letter outline:',
    list(p.letterOutline),
    '',
    'Conceding is the honest call when:',
    list(p.concedeWhen),
  ].join('\n');
}
