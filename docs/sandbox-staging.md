# Staging real sandbox disputes

PayPal does **not** let you create disputes through the API, and the webhook simulator sends fake resource ids that fail signature verification and 404 on `GET dispute`. Every dispute in the demo is therefore a real sandbox dispute opened by a sandbox buyer. This runbook stages them.

## 0. Prerequisites

- A PayPal developer account at https://developer.paypal.com.
- `.env` filled from `.env.example` (sandbox credentials only).
- `npm ci && npm run setup`.

## 1. Create sandbox accounts

1. Developer Dashboard → **Testing Tools → Sandbox Accounts**.
2. Create (or reuse) one **Business** account: this is the seller, Juniper Thread Co.
3. Create one **Personal** account: this is the buyer. Note its email and password; give it a PayPal balance so it pays from the **wallet**.
4. Developer Dashboard → **Apps & Credentials** (Sandbox) → create an app owned by the business account. Copy the client id and secret into `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `NEXT_PUBLIC_PAYPAL_CLIENT_ID`.

## 2. Register the webhook

The webhook needs a public HTTPS URL: the Render URL, or an ngrok tunnel when running locally (`ngrok http 3000`).

```bash
PUBLIC_BASE_URL=https://<your-host> npm run webhook:register
```

Copy the printed id into `PAYPAL_WEBHOOK_ID` and restart the app.

## 3. Seed the store and buy items

```bash
npm run seed
npm run dev
```

1. Open `http://localhost:3000/store` (or the Render URL).
2. Buy one item per dispute you plan to stage. Log in as the sandbox **Personal** buyer and pay with the **PayPal wallet** (not a card). Card payments cannot be disputed from the Resolution Center.
3. Each capture is stored in SQLite and gets a fixture tracking number through `trackers-batch`. If any order is missing tracking, run:

```bash
npm run seed -- --tracking
```

Suggested basket (about 6 disputes, 2 per reason):

| Reason to open | SKU | Why |
|---|---|---|
| Item not received | JT-107 Brushed Flannel Overshirt | Delivered tracking with signature: strong fight |
| Item not received | JT-105 Merino Rib Beanie | Fight or concede depending on tracking |
| Not as described | JT-114 Linen Wrap Dress | Matches the sizing pattern in the history |
| Not as described | JT-108 Garment-Dyed Crew Tee | Color variation, policy clause 5 |
| Unauthorised | JT-119 Chunky Knit Cardigan | High value, signature confirmation |
| Unauthorised | JT-111 Linen Camp Shirt | Weak evidence: the agent should recommend conceding |

## 4. Open the disputes

1. Go to https://www.sandbox.paypal.com and log in as the **buyer**.
2. **Resolution Center → Report a problem**, choose the transaction.
3. Pick the reason: *I didn't receive an item*, *Item is significantly not as described*, or *Unauthorized transaction*.
4. Write a short, realistic buyer message (fictional details only).
5. Submit. In a few seconds PayPal sends `CUSTOMER.DISPUTE.CREATED` to the webhook. If it does not, the poller picks the dispute up within 30 s (`POLL_INTERVAL_MS`).

## 5. Move disputes to `WAITING_FOR_SELLER_RESPONSE`

Most disputes open as inquiries. To make one accept evidence:

1. If needed, escalate to a claim from the buyer side (Resolution Center → the case → **Escalate**), or wait for the sandbox to escalate.
2. In the app, open the dispute and use **Sandbox controls → Require evidence → SELLER_EVIDENCE**. This calls `POST /v1/customer/disputes/{id}/require-evidence` with `{"action":"SELLER_EVIDENCE"}`.
3. Run `npm run sync` and confirm the status column shows `WAITING_FOR_SELLER_RESPONSE`.

## 6. First milestone: static evidence

Before any AI work, prove `provide-evidence` returns 200:

```bash
npx tsx scripts/make-static-evidence.ts
npm run smoke:evidence -- PP-D-XXXXX
```

The script prints the HTTP status and the `paypal-debug-id`. Record the debug id; it is what PayPal support asks for.

## 7. The demo pool

The **Trigger demo dispute** button takes the oldest dispute that is `WAITING_FOR_SELLER_RESPONSE` and has no agent run yet. Check the pool:

```bash
curl -s http://localhost:3000/api/demo/pool
```

Keep at least 4 disputes in the pool before recording. When the pool is empty the button returns `409 POOL_EMPTY`; restock by repeating steps 3–5. The app never fakes a dispute.

## 8. Resolve on camera

After submitting evidence, **Sandbox controls → Adjudicate → SELLER_FAVOR** (or `BUYER_FAVOR`) calls the sandbox-only `adjudicate` endpoint. The `CUSTOMER.DISPUTE.RESOLVED` webhook then updates the outcome.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Webhook stored with `verified=0` | `PAYPAL_WEBHOOK_ID` does not match the registered webhook, or the event came from the simulator |
| `provide-evidence` returns 422 | Check `evidence_type` against `src/lib/paypal/evidence-rules.ts` and the dispute status |
| Buyer cannot see the transaction in Resolution Center | The order was paid by card, or by a different buyer account |
| Nothing appears after restart on Render | The DB is rebuilt on boot; wait one poll interval or press **Sync** |