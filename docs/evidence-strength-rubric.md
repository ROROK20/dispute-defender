# Evidence strength rubric

This is the human-readable copy of `src/lib/scoring/strength.ts`. The score is **evidence strength**, a checklist of what evidence is present. It is not a trained probability and we do not quote any accuracy for it. The expected-value math uses it only as "strength used as a rough win proxy, not a trained probability".

Each item is either present or absent. A present item adds its full weight. Each item lists the source ids (`S1…Sn`) that prove it, so the seller can open the exact tool result behind every point. Weights sum to 100 for each reason code.

## Item not received (`MERCHANDISE_OR_SERVICE_NOT_RECEIVED`)

| Item | Weight | Present when |
|---|---|---|
| Tracking attached in PayPal | 25 | A PayPal tracker exists for the capture |
| Carrier shows delivered | 30 | A carrier event has status `DELIVERED` |
| Delivery ZIP matches order ship-to | 20 | The delivered event ZIP equals the order's `postal_code` |
| Signature captured | 15 | The carrier record has a signature name |
| Shipped before buyer's claim date | 10 | The first carrier event is earlier than the dispute `create_time` |

## Not as described (`MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`)

| Item | Weight | Present when |
|---|---|---|
| Listing description matches delivered SKU | 25 | The order line item SKU equals the SKU whose description is cited |
| Policy published before purchase | 20 | The returns policy `published_at` is earlier than the capture time |
| Seller responded in under 48 h | 15 | The first seller message is within 48 hours of the first buyer message |
| Offered return per policy | 20 | A seller message offers a return or exchange, and the returns policy is cited |
| No prior SNAD on this SKU in 90 days | 20 | No other SNAD dispute on the same SKU was created in the previous 90 days |

## Unauthorised (`UNAUTHORISED`)

| Item | Weight | Present when |
|---|---|---|
| Delivered to the PayPal-verified ship-to | 35 | Delivered event ZIP equals the order ship-to, and the payer account status is `VERIFIED` |
| Signature | 25 | The carrier record has a signature name |
| Prior non-disputed orders from the same buyer | 20 | Another completed order from the same buyer email with no dispute |
| Delivery confirmed | 20 | A carrier event has status `DELIVERED` |

## Any other reason

Scored 0 with a breakdown that says the reason code has no rubric. The agent still drafts, and the expected-value math will usually recommend conceding.

## How the score is used

- Shown as a bar in the inbox and as a breakdown (hover or tap) on the detail view.
- Fed as `s = score / 100` into `expected-value.ts`:
  - Fight: `(1 − s)·(A + F) + T`
  - Accept claim: `A + F` (minus `C·0.5` when the item comes back, labeled "half resale value of returned item")
  - Make offer at `o·A`: `o·A + F·0.5`, labeled "assumes buyer accepts the offer"
- Claude cannot change either number. It only explains them.

## Changing the rubric

Edit `strength.ts` and this file in the same commit. `tests/unit/strength.test.ts` asserts that each reason's weights sum to 100.