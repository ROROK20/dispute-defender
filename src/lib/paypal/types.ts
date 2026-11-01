/**
 * Typed shapes for the PayPal REST resources DisputeDefender touches.
 * Only the fields the app reads are typed; everything else is kept loosely
 * so a richer sandbox payload never breaks parsing.
 */

export type PayPalEnv = 'sandbox' | 'live';

export const REASON_CODES = [
  'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
  'UNAUTHORISED',
  'CREDIT_NOT_PROCESSED',
  'DUPLICATE_TRANSACTION',
  'INCORRECT_AMOUNT',
  'PAYMENT_BY_OTHER_MEANS',
  'CANCELED_RECURRING_BILLING',
  'PROBLEM_WITH_REMITTANCE',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const EVIDENCE_TYPES = [
  'PROOF_OF_FULFILLMENT',
  'PROOF_OF_REFUND',
  'PROOF_OF_DELIVERY_SIGNATURE',
  'PROOF_OF_RECEIPT_COPY',
  'RETURN_POLICY',
  'BILLING_AGREEMENT',
  'PROOF_OF_RESHIPMENT',
  'ITEM_DESCRIPTION',
  'POLICE_REPORT',
  'AFFIDAVIT',
  'PAID_WITH_OTHER_METHOD',
  'COPY_OF_CONTRACT',
  'TERMINAL_ATM_RECEIPT',
  'PRICE_DIFFERENCE_REASON',
  'SOURCE_CONVERSION_RATE',
  'BANK_STATEMENT',
  'CREDIT_DUE_REASON',
  'REQUEST_CREDIT_RECEIPT',
  'PROOF_OF_RETURN',
  'CREATE',
  'CHANGE_REASON',
  'OTHER',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type DisputeStatus =
  | 'OPEN'
  | 'WAITING_FOR_BUYER_RESPONSE'
  | 'WAITING_FOR_SELLER_RESPONSE'
  | 'UNDER_REVIEW'
  | 'RESOLVED'
  | 'OTHER';

export type DisputeLifeCycleStage = 'INQUIRY' | 'CHARGEBACK' | 'PRE_ARBITRATION' | 'ARBITRATION';

export type DisputeOutcomeCode =
  | 'RESOLVED_BUYER_FAVOUR'
  | 'RESOLVED_SELLER_FAVOUR'
  | 'RESOLVED_WITH_PAYOUT'
  | 'CANCELED_BY_BUYER'
  | 'ACCEPTED'
  | 'DENIED'
  | 'NONE';

export type OfferType = 'REFUND' | 'REFUND_WITH_RETURN' | 'REFUND_WITH_REPLACEMENT' | 'REPLACEMENT_WITHOUT_REFUND';

export type AdjudicationOutcome = 'SELLER_FAVOR' | 'BUYER_FAVOR';
export type RequireEvidenceAction = 'SELLER_EVIDENCE' | 'BUYER_EVIDENCE';

export type TrackerStatus =
  | 'CANCELLED'
  | 'DELIVERED'
  | 'LOCAL_PICKUP'
  | 'ON_HOLD'
  | 'SHIPPED'
  | 'SHIPMENT_CREATED'
  | 'DROPPED_OFF'
  | 'IN_TRANSIT'
  | 'RETURNED'
  | 'LABEL_PRINTED'
  | 'ERROR'
  | 'UNCONFIRMED'
  | 'PICKUP_FAILED'
  | 'DELIVERY_DELAYED'
  | 'DELIVERY_SCHEDULED'
  | 'DELIVERY_FAILED'
  | 'INRETURN'
  | 'IN_PROCESS'
  | 'NEW'
  | 'VOID'
  | 'PROCESSED'
  | 'NOT_SHIPPED';

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalLink {
  href: string;
  rel: string;
  method?: string;
}

export interface DisputeMessage {
  posted_by: 'BUYER' | 'SELLER' | 'ARBITER' | string;
  time_posted: string;
  content: string;
  documents?: { name: string; url?: string }[];
}

export interface DisputedTransaction {
  buyer_transaction_id?: string;
  seller_transaction_id?: string;
  reference_id?: string;
  create_time?: string;
  transaction_status?: string;
  gross_amount?: PayPalMoney;
  invoice_number?: string;
  custom?: string;
  buyer?: { email?: string; name?: string; payer_id?: string };
  seller?: { email?: string; merchant_id?: string; name?: string };
  items?: {
    item_id?: string;
    item_name?: string;
    item_description?: string;
    item_quantity?: string;
    partner_transaction_id?: string;
    reason?: string;
    dispute_amount?: PayPalMoney;
    notes?: string;
  }[];
}

export interface DisputeEvidence {
  evidence_type: EvidenceType | string;
  evidence_info?: {
    tracking_info?: { carrier_name: string; tracking_number: string; carrier_name_other?: string }[];
    refund_ids?: { refund_id: string }[];
  };
  documents?: { name: string; url?: string }[];
  notes?: string;
  source?: string;
  date?: string;
}

export interface PayPalDispute {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  disputed_transactions?: DisputedTransaction[];
  reason: ReasonCode | string;
  status: DisputeStatus | string;
  dispute_amount: PayPalMoney;
  dispute_outcome?: { outcome_code: DisputeOutcomeCode | string; amount_refunded?: PayPalMoney };
  dispute_life_cycle_stage?: DisputeLifeCycleStage | string;
  dispute_channel?: string;
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  messages?: DisputeMessage[];
  evidences?: DisputeEvidence[];
  offer?: { buyer_requested_amount?: PayPalMoney; seller_offered_amount?: PayPalMoney; offer_type?: string };
  links?: PayPalLink[];
  [key: string]: unknown;
}

export interface PayPalDisputeSummary {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason: string;
  status: string;
  dispute_state?: string;
  dispute_amount?: PayPalMoney;
  dispute_life_cycle_stage?: string;
  links?: PayPalLink[];
}

export interface PayPalDisputeList {
  items?: PayPalDisputeSummary[];
  links?: PayPalLink[];
}

export interface PayPalAddress {
  address_line_1?: string;
  address_line_2?: string;
  admin_area_2?: string;
  admin_area_1?: string;
  postal_code?: string;
  country_code?: string;
}

export interface PayPalCapture {
  id: string;
  status: string;
  amount?: PayPalMoney;
  final_capture?: boolean;
  seller_protection?: { status?: string; dispute_categories?: string[] };
  invoice_id?: string;
  custom_id?: string;
  create_time?: string;
  update_time?: string;
  supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string } };
  links?: PayPalLink[];
  [key: string]: unknown;
}

export interface PayPalOrderItem {
  name: string;
  quantity: string;
  sku?: string;
  description?: string;
  unit_amount?: PayPalMoney;
  category?: string;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  description?: string;
  custom_id?: string;
  amount?: PayPalMoney & { breakdown?: Record<string, PayPalMoney> };
  items?: PayPalOrderItem[];
  shipping?: { name?: { full_name?: string }; address?: PayPalAddress; type?: string };
  payments?: { captures?: PayPalCapture[] };
}

export interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED' | string;
  intent?: 'CAPTURE' | 'AUTHORIZE' | string;
  create_time?: string;
  update_time?: string;
  payer?: {
    name?: { given_name?: string; surname?: string };
    email_address?: string;
    payer_id?: string;
    address?: PayPalAddress;
  };
  payment_source?: Record<string, unknown>;
  purchase_units?: PayPalPurchaseUnit[];
  links?: PayPalLink[];
  [key: string]: unknown;
}

export interface PayPalTracker {
  transaction_id: string;
  tracking_number?: string;
  status: TrackerStatus | string;
  carrier?: string;
  carrier_name_other?: string;
  shipment_date?: string;
  last_updated_time?: string;
  notify_buyer?: boolean;
  links?: PayPalLink[];
  [key: string]: unknown;
}

export interface TrackerInput {
  transaction_id: string;
  tracking_number: string;
  status: TrackerStatus;
  carrier: string;
  carrier_name_other?: string;
  shipment_date?: string;
  notify_buyer?: boolean;
}

export interface TrackersBatchResponse {
  tracker_identifiers?: { transaction_id: string; tracking_number?: string; links?: PayPalLink[] }[];
  errors?: { name?: string; message?: string; details?: unknown[] }[];
  links?: PayPalLink[];
}

export interface PayPalWebhookEvent<R = Record<string, unknown>> {
  id: string;
  event_version?: string;
  create_time: string;
  resource_type?: string;
  resource_version?: string;
  event_type: string;
  summary?: string;
  resource: R;
  links?: PayPalLink[];
}

export type DisputeWebhookEventType =
  | 'CUSTOMER.DISPUTE.CREATED'
  | 'CUSTOMER.DISPUTE.UPDATED'
  | 'CUSTOMER.DISPUTE.RESOLVED';

export const DISPUTE_WEBHOOK_EVENT_TYPES: readonly DisputeWebhookEventType[] = [
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
] as const;

export interface WebhookVerificationHeaders {
  auth_algo: string;
  cert_url: string;
  transmission_id: string;
  transmission_sig: string;
  transmission_time: string;
}

export type VerificationStatus = 'SUCCESS' | 'FAILURE';

export interface VerifyWebhookResponse {
  verification_status: VerificationStatus;
}

/** Normalised result of every PayPal call; mirrors a `paypal_calls` row. */
export interface PayPalCallResult<T> {
  ok: boolean;
  status: number;
  debug_id: string | null;
  duration_ms: number;
  data: T | null;
  error?: { name?: string; message: string; details?: unknown };
}

export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: { field?: string; issue?: string; description?: string }[];
  error?: string;
  error_description?: string;
}

export class PayPalApiError extends Error {
  readonly status: number;
  readonly debugId: string | null;
  readonly errorName: string | null;
  readonly details: unknown;

  constructor(opts: { status: number; message: string; debugId?: string | null; name?: string | null; details?: unknown }) {
    super(opts.message);
    this.name = 'PayPalApiError';
    this.status = opts.status;
    this.debugId = opts.debugId ?? null;
    this.errorName = opts.name ?? null;
    this.details = opts.details;
  }
}

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

export function isEvidenceType(value: unknown): value is EvidenceType {
  return typeof value === 'string' && (EVIDENCE_TYPES as readonly string[]).includes(value);
}

export function moneyToCents(money: PayPalMoney | undefined | null): number {
  if (!money || typeof money.value !== 'string') return 0;
  const n = Number(money.value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function centsToMoney(cents: number, currency = 'USD'): PayPalMoney {
  return { currency_code: currency, value: (Math.round(cents) / 100).toFixed(2) };
}