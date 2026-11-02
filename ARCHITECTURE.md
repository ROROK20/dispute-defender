# DisputeDefender: Architecture

## 1. Project overview

DisputeDefender is a dispute agent for small PayPal sellers. A `CUSTOMER.DISPUTE.CREATED` webhook starts a Claude tool-use agent. The agent pulls the dispute, the capture/order, the tracking and the buyer messages from the PayPal sandbox. It scores the evidence against a published rubric for the reason code and decides on expected value whether to **fight** or **concede**. If it fights, it drafts a response in which every sentence cites a stored tool result. The seller approves once, and only then does the app call `provide-evidence`, `accept-claim` or `make-offer`. A patterns view mines root causes across disputes, so the same dispute does not happen again.

The design follows two rules throughout. **Nothing goes to PayPal without seller approval**, and **no sentence goes into a submission unless it traces to a stored source.**

---

## 2. System components and responsibilities

| # | Component | Location | Responsibility |
|---|---|---|---|
| C1 | **Seed storefront** ("Juniper Thread Co.") | `src/app/store/*`, `src/app/api/store/*` | Product grid with ~20 SKUs and PayPal Checkout buttons (`@paypal/react-paypal-js`). Creates and captures real Orders v2 sandbox orders. Also serves the returns, shipping and size-guide policy pages. Disputes are raised against these orders. |
| C2 | **PayPal client** | `src/lib/paypal/*` | OAuth2 client-credentials token cache. A typed `fetch` wrapper logs every call (method, path, status, `paypal-debug-id`, duration) to `paypal_calls`. Typed wrappers cover Disputes v1, Orders v2 / Payments v2 captures, Add Tracking and verify-webhook-signature. A `PAYPAL_MOCK=1` adapter (tests and CI only) returns fixtures and shows a red "MOCK MODE" banner in the UI. |
| C3 | **Webhook receiver** | `src/app/api/webhooks/paypal/route.ts` | Reads the raw body and verifies the signature through `POST /v1/notifications/verify-webhook-signature`. Stores the event idempotently (by event id) and returns `200` within about 1 s. Then schedules the job: sync the dispute and start an agent run. Unverified events get `400` and are stored with `verified=0`. |
| C4 | **Poller fallback** | `src/instrumentation.ts`, `src/lib/sync.ts` | Every 30 s on the server, lists disputes updated since the last sync. Any new dispute in `WAITING_FOR_SELLER_RESPONSE` with no run gets a synthetic event (`source='poll'`) and a run. This covers slow webhook delivery. |
| C5 | **Agent runner** | `src/lib/agent/*` | Claude tool-use loop. Each tool result is stored as a numbered **source** (`S1…Sn`). Every step (tool call, result, check, decision) is written to `agent_steps` and emitted on an in-process event bus for the trace view. Ends with a forced `submit_analysis` tool call that returns the classification, a decision, and a draft as sentences with citations. |
| C6 | **Citation checker** | `src/lib/agent/citations.ts` | Deterministic checks. Every sentence must have at least one `source_id` that exists in this run. Every number, date, tracking number and quoted string in a sentence must appear in the text of one of its cited sources. A failed sentence is sent back to the model with the reason, up to 2 repair rounds. Sentences that still fail are removed and listed in the UI as "removed, unsupported". |
| C7 | **Opus review pass** | `src/lib/agent/review.ts` | Opus may only reword sentences, keeping the same sentence ids and `source_ids`. The output goes back through C6. If any sentence then fails, the Sonnet draft is kept and the step logs "review discarded". |
| C8 | **Scoring and decision** | `src/lib/scoring/*` | `strength.ts` is a deterministic rubric per reason code that returns 0–100 plus a breakdown item by item. `expected-value.ts` does plain arithmetic for fight vs. accept-claim vs. make-offer and returns the formula with its values filled in. Claude cannot override either one; it only explains the result. |
| C9 | **Evidence packet** | `src/lib/pdf/*` | `@react-pdf/renderer` builds the PDF: cover letter, timeline, tracking proof, message excerpt, policy clause, and one footnote per citation. Target size is under 500 KB. |
| C10 | **Submission service** | `src/lib/submit.ts` | Runs only from seller-approved routes. Before calling PayPal it re-fetches the dispute and checks `status === WAITING_FOR_SELLER_RESPONSE`, `now < seller_response_due_date`, that the evidence types are allowed for the reason code, and that the PDF is under 10 MB. Then it builds the multipart `provide-evidence` request (or `accept-claim` / `make-offer` / `send-message`) and records the result with its `debug_id`. |
| C11 | **Pattern miner** | `src/lib/patterns/mine.ts` | Groups disputes by `(sku, reason)` deterministically. Claude tags each buyer message with themes from a closed list. **Code counts the tags** (to produce "4 of 6"), and each pattern stores the message ids and verbatim quotes (each quote is checked as a substring of its message). Output is a headline plus a prevention action. |
| C12 | **Seller UI** | `src/app/*`, `src/components/*` | Inbox built on AG Grid Community, a dispute detail view (live trace, stopwatch, draft with citation chips, source drawer, PDF preview, decision panel), a Patterns page, and a "Trigger demo dispute" button. Every page has designed empty, loading, error and resolved states. Approval works on mobile. |
| C13 | **Demo trigger** | `src/app/api/demo/trigger/route.ts` | Rate-limited. Takes the oldest **real staged sandbox dispute** from the pool (status `WAITING_FOR_SELLER_RESPONSE`, no run yet), stores an event with `source='demo_trigger'` and starts a run. The UI labels these events "Demo trigger (not a PayPal webhook)". If the pool is empty it returns `409` with restocking instructions and never fakes a dispute. |
| C14 | **Sandbox lifecycle tools** | `src/app/api/disputes/[id]/simulate/route.ts` | Wraps the sandbox-only `require-evidence` and `adjudicate` endpoints, so a dispute can be moved to a resolution on camera. Disabled when `PAYPAL_ENV !== 'sandbox'`. |

### Hard constraints (verified API facts every generator must respect)

- **Disputes cannot be created through the API.** A sandbox buyer opens them at `https://www.sandbox.paypal.com/` → Resolution Center, against an order paid with the **PayPal wallet**. Steps are in `docs/sandbox-staging.md`.
- **The webhook simulator sends fake resource IDs** that fail signature verification and return 404 on `GET dispute`. It cannot drive the full flow. The fallbacks are the poller (C4) and the demo trigger (C13).
- **Signature verification:** send `webhook_event` as the **original raw JSON**, never re-serialized. Build the request body by inserting the raw body string into the JSON template (`src/lib/paypal/webhooks.ts`).
- **AG Grid row grouping and master/detail are Enterprise-only.** Use Community only: custom cell renderers, **full-width detail rows** (`isFullWidthRow` + `fullWidthCellRenderer`) to expand the agent trace, a "group by" select that groups in our own code and inserts group-header full-width rows, quick filter, pinned bottom totals row, CSV export, and the Theming API (`themeQuartz.withParams`).
- **Fixture history:** for the pattern miner to have volume, `data/fixtures/historical-disputes.json` loads with `source='fixture'`. Fixture rows show a "Fixture history" badge, and every PayPal-mutating route rejects them with `422`.
- **Render free tier:** no persistent disk, so SQLite is rebuilt on every boot (`npm run setup` runs in `startCommand`, and the poller then pulls live sandbox disputes back in). Free web services sleep after 15 min idle. PayPal retries webhooks, and the poller catches up after the first request. Both points are documented in the README.

---

## 3. Complete file and directory tree

```
dispute-defender/
├── .env.example
├── .gitignore
├── .gitleaks.toml
├── .nvmrc
├── .pre-commit-config.yaml
├── LICENSE
├── README.md
├── ARCHITECTURE.md
├── package.json
├── tsconfig.json
├── next.config.ts
├── next-env.d.ts
├── postcss.config.mjs
├── eslint.config.mjs
├── vitest.config.ts
├── playwright.config.ts
├── render.yaml
├── db/
│   └── schema.sql
├── data/
│   ├── fixtures/
│   │   ├── store.json
│   │   ├── historical-disputes.json
│   │   ├── carrier-events.json
│   │   └── mock-paypal/
│   │       ├── dispute-inr.json
│   │       ├── dispute-snad.json
│   │       ├── dispute-unauth.json
│   │       ├── capture.json
│   │       ├── order.json
│   │       ├── tracker.json
│   │       └── provide-evidence-200.json
│   └── policies/
│       ├── returns-policy.md
│       ├── shipping-policy.md
│       └── size-guide.md
├── docs/
│   ├── architecture.md
│   ├── demo-runbook.md
│   ├── sandbox-staging.md
│   └── evidence-strength-rubric.md
├── postman/
│   ├── DisputeDefender.postman_collection.json
│   └── DisputeDefender.sandbox.postman_environment.json
├── public/
│   ├── juniper-logo.svg
│   └── og-image.png
├── scripts/
│   ├── setup.ts
│   ├── seed-store.ts
│   ├── register-webhook.ts
│   ├── sync-disputes.ts
│   ├── make-static-evidence.ts
│   └── smoke-provide-evidence.ts
├── src/
│   ├── instrumentation.ts
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── icon.svg
│   │   ├── page.tsx
│   │   ├── loading.tsx
│   │   ├── error.tsx
│   │   ├── not-found.tsx
│   │   ├── disputes/
│   │   │   └── [id]/
│   │   │       ├── page.tsx
│   │   │       └── loading.tsx
│   │   ├── patterns/
│   │   │   └── page.tsx
│   │   ├── activity/
│   │   │   └── page.tsx
│   │   ├── store/
│   │   │   ├── page.tsx
│   │   │   ├── layout.tsx
│   │   │   ├── thank-you/
│   │   │   │   └── page.tsx
│   │   │   └── policies/
│   │   │       └── [slug]/
│   │   │           └── page.tsx
│   │   └── api/
│   │       ├── health/
│   │       │   └── route.ts
│   │       ├── webhooks/
│   │       │   └── paypal/
│   │       │       └── route.ts
│   │       ├── disputes/
│   │       │   ├── route.ts
│   │       │   ├── sync/
│   │       │   │   └── route.ts
│   │       │   └── [id]/
│   │       │       ├── route.ts
│   │       │       ├── run/
│   │       │       │   └── route.ts
│   │       │       ├── stream/
│   │       │       │   └── route.ts
│   │       │       ├── pdf/
│   │       │       │   └── route.ts
│   │       │       ├── approve/
│   │       │       │   └── route.ts
│   │       │       ├── concede/
│   │       │       │   └── route.ts
│   │       │       ├── message/
│   │       │       │   └── route.ts
│   │       │       └── simulate/
│   │       │           └── route.ts
│   │       ├── demo/
│   │       │   ├── trigger/
│   │       │   │   └── route.ts
│   │       │   └── pool/
│   │       │       └── route.ts
│   │       ├── patterns/
│   │       │   ├── route.ts
│   │       │   └── recompute/
│   │       │       └── route.ts
│   │       ├── paypal-calls/
│   │       │   └── route.ts
│   │       └── store/
│   │           └── orders/
│   │               ├── route.ts
│   │               └── [orderId]/
│   │                   └── capture/
│   │                       └── route.ts
│   ├── components/
│   │   ├── AppShell.tsx
│   │   ├── NavTabs.tsx
│   │   ├── SandboxBadge.tsx
│   │   ├── MockModeBanner.tsx
│   │   ├── TriggerDemoButton.tsx
│   │   ├── EmptyState.tsx
│   │   ├── ErrorBanner.tsx
│   │   ├── Skeleton.tsx
│   │   ├── grid/
│   │   │   ├── DisputeGrid.tsx
│   │   │   ├── gridTheme.ts
│   │   │   ├── DeadlineCell.tsx
│   │   │   ├── StatusPill.tsx
│   │   │   ├── StrengthBarCell.tsx
│   │   │   ├── AmountCell.tsx
│   │   │   ├── ReasonCell.tsx
│   │   │   ├── RecommendationCell.tsx
│   │   │   ├── GroupHeaderRow.tsx
│   │   │   ├── TraceDetailRow.tsx
│   │   │   └── PatternsGrid.tsx
│   │   ├── dispute/
│   │   │   ├── DisputeHeader.tsx
│   │   │   ├── Stopwatch.tsx
│   │   │   ├── AgentTrace.tsx
│   │   │   ├── TraceStep.tsx
│   │   │   ├── Timeline.tsx
│   │   │   ├── DraftResponse.tsx
│   │   │   ├── CitationChip.tsx
│   │   │   ├── SourceDrawer.tsx
│   │   │   ├── RemovedSentences.tsx
│   │   │   ├── StrengthBreakdown.tsx
│   │   │   ├── DecisionPanel.tsx
│   │   │   ├── ExpectedValueMath.tsx
│   │   │   ├── PdfPreview.tsx
│   │   │   ├── SubmissionResult.tsx
│   │   │   └── SandboxControls.tsx
│   │   ├── patterns/
│   │   │   └── PatternCard.tsx
│   │   └── store/
│   │       ├── ProductCard.tsx
│   │       └── Checkout.tsx
│   ├── hooks/
│   │   ├── useDisputeStream.ts
│   │   └── useNow.ts
│   └── lib/
│       ├── env.ts
│       ├── db.ts
│       ├── ids.ts
│       ├── format.ts
│       ├── ratelimit.ts
│       ├── bus.ts
│       ├── sync.ts
│       ├── submit.ts
│       ├── jobs.ts
│       ├── repo/
│       │   ├── disputes.ts
│       │   ├── orders.ts
│       │   ├── skus.ts
│       │   ├── webhookEvents.ts
│       │   ├── runs.ts
│       │   ├── steps.ts
│       │   ├── sources.ts
│       │   ├── decisions.ts
│       │   ├── paypalCalls.ts
│       │   └── patterns.ts
│       ├── paypal/
│       │   ├── client.ts
│       │   ├── mock.ts
│       │   ├── types.ts
│       │   ├── disputes.ts
│       │   ├── orders.ts
│       │   ├── tracking.ts
│       │   ├── webhooks.ts
│       │   ├── multipart.ts
│       │   └── evidence-rules.ts
│       ├── carrier/
│       │   ├── adapter.ts
│       │   └── fixture-provider.ts
│       ├── agent/
│       │   ├── anthropic.ts
│       │   ├── runner.ts
│       │   ├── tools.ts
│       │   ├── prompts.ts
│       │   ├── playbooks.ts
│       │   ├── schemas.ts
│       │   ├── citations.ts
│       │   ├── review.ts
│       │   └── mock-agent.ts
│       ├── scoring/
│       │   ├── strength.ts
│       │   └── expected-value.ts
│       ├── patterns/
│       │   ├── mine.ts
│       │   └── themes.ts
│       └── pdf/
│           ├── EvidencePacket.tsx
│           ├── styles.ts
│           └── render.ts
└── tests/
    ├── unit/
    │   ├── citations.test.ts
    │   ├── strength.test.ts
    │   ├── expected-value.test.ts
    │   ├── evidence-rules.test.ts
    │   ├── multipart.test.ts
    │   ├── webhook-verify-body.test.ts
    │   ├── patterns-count.test.ts
    │   └── submit-guards.test.ts
    ├── integration/
    │   ├── agent-run.mock.test.ts
    │   └── webhook-route.test.ts
    └── e2e/
        └── demo-loop.spec.ts
```

### What each non-obvious file contains

- `.env.example`: `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `NEXT_PUBLIC_PAYPAL_CLIENT_ID`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL_AGENT=claude-sonnet-5-5`, `ANTHROPIC_MODEL_REVIEW=claude-opus-5-5`, `REVIEW_ENABLED=true`, `DATABASE_PATH=./data/app.db`, `PUBLIC_BASE_URL`, `DISPUTE_FEE_USD=0` (the seller sets their own fee schedule; no fee number is hard-coded), `SELLER_TIME_COST_USD=15`, `DEMO_TRIGGER_PER_IP_PER_MIN=1`, `DEMO_TRIGGER_GLOBAL_PER_HOUR=10`, `PAYPAL_MOCK=0`, `ANTHROPIC_MOCK=0`, `POLL_INTERVAL_MS=30000`.
- `.pre-commit-config.yaml`: the gitleaks hook (`gitleaks/gitleaks` rev `v8.28.0`). `.gitleaks.toml` extends the default rules and allowlists `.env.example`.
- `render.yaml`: one `web` service, runtime `node`, plan `free`, `buildCommand: npm ci && npm run build`, `startCommand: npm run setup && npm start`, `healthCheckPath: /api/health`, env vars set to `sync: false` for secrets, `NODE_VERSION=22.20.0`.
- `db/schema.sql`: section 5, verbatim.
- `data/fixtures/store.json`: 20 SKUs (`JT-101`…`JT-120`; SKU `JT-114` is "Linen Wrap Dress") with price, COGS and description, plus a policy index with `published_at` dates set **before** any order date.
- `data/fixtures/historical-disputes.json`: about 12 fixture disputes (INR / SNAD / UNAUTHORISED). At least 6 are SNAD on `JT-114`, and 4 of those mention sizing in buyer messages. Every buyer is fictional, and the file carries `"source": "fixture"`.
- `data/fixtures/carrier-events.json`: carrier-adapter fixture events keyed by tracking number (accepted, in transit, delivered, signature name, delivery ZIP).
- `docs/sandbox-staging.md`: the step-by-step runbook. Create the sandbox business and personal accounts, run `seed-store`, buy N items through the storefront with the sandbox buyer wallet, open disputes in the sandbox Resolution Center (one per reason), escalate to claim where needed, and call `simulate` → `require-evidence` with `SELLER_EVIDENCE`.
- `docs/demo-runbook.md`: the video script with timestamps, three-take protocol, and the rule that "the stopwatch shows measured times only".
- `docs/evidence-strength-rubric.md`: the human-readable copy of `strength.ts`.
- `postman/*.json`: Postman Collection v2.1. It has requests for the OAuth token, list/show dispute, provide-evidence (multipart), accept-claim, make-offer, send-message, require-evidence, adjudicate, trackers-batch, get capture, get order and verify-webhook-signature. Variables are `{{base_url}}`, `{{access_token}}` and `{{dispute_id}}`.
- `scripts/seed-store.ts`: loads SKUs into SQLite. With `--tracking`, it adds tracking (`trackers-batch`) for every captured sandbox order in the DB that has none, using fixture tracking numbers. It **does not** fake orders: real orders come from the storefront.
- `scripts/make-static-evidence.ts`: writes `data/static-evidence.pdf`, a hand-made PDF for the first `provide-evidence` milestone in hours 1–4.
- `scripts/smoke-provide-evidence.ts`: `tsx scripts/smoke-provide-evidence.ts <disputeId>` submits the static PDF through `src/lib/paypal/disputes.ts` and prints status and `debug_id`.
- `scripts/register-webhook.ts`: `POST /v1/notifications/webhooks` for the three dispute events to `${PUBLIC_BASE_URL}/api/webhooks/paypal`. Prints the webhook id to put in `PAYPAL_WEBHOOK_ID`.
- `scripts/setup.ts`: applies `schema.sql`, loads `store.json` and fixture history (idempotent), then runs one `sync-disputes` pass if credentials exist.
- `src/instrumentation.ts`: `export async function register()`. When `process.env.NEXT_RUNTIME === 'nodejs'`, it starts the poller from `src/lib/sync.ts` (guarded by a `globalThis` flag).
- `src/lib/bus.ts`: one `EventEmitter` stored on `globalThis.__ddBus`, so it survives HMR. Event name `run:<runId>`.
- `src/lib/jobs.ts`: `enqueueRun(disputeId, eventId)` runs `setImmediate` → `runAgent()`. Uses an in-memory per-dispute mutex together with the DB partial unique index.
- `src/lib/agent/mock-agent.ts` and `src/lib/paypal/mock.ts`: used only when the `*_MOCK=1` flags are set (tests and CI). Both render the `MockModeBanner`.

---

## 4. Tech stack (exact pinned versions)

Runtime: **Node.js 22.20.0 LTS** (`.nvmrc`: `22.20.0`). Package manager: npm 10.x with `package-lock.json` committed.

### `dependencies`

| Package | Version | Use |
|---|---|---|
| `next` | `15.5.4` | App Router, route handlers, `instrumentation.ts` |
| `react` / `react-dom` | `19.1.1` | UI |
| `@anthropic-ai/sdk` | `0.65.0` | Claude Messages API with tool use |
| `ag-grid-community` | `34.2.0` | Grid engine (Community modules only) |
| `ag-grid-react` | `34.2.0` | React wrapper |
| `@react-pdf/renderer` | `4.3.1` | Evidence-packet PDF (server side) |
| `@paypal/react-paypal-js` | `8.9.2` | Storefront Checkout buttons |
| `better-sqlite3` | `12.4.1` | Embedded DB |
| `zod` | `3.25.76` | Env, request and tool-schema validation |
| `nanoid` | `5.1.6` | IDs |
| `clsx` | `2.1.1` | Class composition |
| `date-fns` | `4.1.0` | Deadlines and countdowns |

### `devDependencies`

| Package | Version |
|---|---|
| `typescript` | `5.9.3` |
| `@types/node` | `22.18.8` |
| `@types/react` | `19.1.17` |
| `@types/react-dom` | `19.1.11` |
| `@types/better-sqlite3` | `7.6.13` |
| `tailwindcss` | `4.1.14` |
| `@tailwindcss/postcss` | `4.1.14` |
| `eslint` | `9.37.0` |
| `eslint-config-next` | `15.5.4` |
| `tsx` | `4.20.6` |
| `vitest` | `3.2.4` |
| `@playwright/test` | `1.56.0` |

### Integration rules generators must follow

- `next.config.ts`: `serverExternalPackages: ['better-sqlite3', '@react-pdf/renderer']`, `output` left at its default. Every route handler that touches the DB, the PDF or the SDK sets `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.
- AG Grid v34: call `ModuleRegistry.registerModules([AllCommunityModule])` once in `src/components/grid/DisputeGrid.tsx` (module scope). Theme via `themeQuartz.withParams({...})` in `gridTheme.ts`. Do **not** import CSS files from AG Grid (Theming API). Do **not** import `ag-grid-enterprise`.
- Tailwind v4: `globals.css` starts with `@import "tailwindcss";` and has an `@theme` block with design tokens. `postcss.config.mjs` uses `{ plugins: { '@tailwindcss/postcss': {} } }`.
- Visual system: one typeface (Inter via `next/font/google`), one accent (`--color-accent: #0f766e`, teal), status colors limited to amber (due soon), red (overdue or lost) and green (won or submitted).
- Anthropic: models come from env. Defaults are `claude-sonnet-5-5` (agent loop, pattern tagging) and `claude-opus-5-5` (review pass only). `max_tokens: 16000` for the agent and `8000` for review. No `temperature` (current models reject non-default sampling) and `tool_choice: auto` only (forced tool choice is rejected); thinking depth is set with `output_config.effort`.
- `package.json` scripts: `dev` (`next dev`), `build` (`next build`), `start` (`next start -p ${PORT:-3000}`), `setup` (`tsx scripts/setup.ts`), `seed` (`tsx scripts/seed-store.ts`), `sync` (`tsx scripts/sync-disputes.ts`), `webhook:register`, `smoke:evidence`, `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `test:e2e` (`playwright test`).

---

## 5. Database schema (`db/schema.sql`, SQLite, WAL mode)

Money is stored as integer cents and times as ISO-8601 UTC text. `db.ts` runs `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` and then executes this file (every statement is `IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS skus (
  sku                TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  category           TEXT NOT NULL,
  price_cents        INTEGER NOT NULL,
  cogs_cents         INTEGER NOT NULL,
  description        TEXT NOT NULL,
  size_chart_version TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id               TEXT PRIMARY KEY,               -- PayPal Orders v2 id (or fixture id)
  capture_id       TEXT UNIQUE,                    -- Payments v2 capture id = dispute seller_transaction_id
  sku              TEXT REFERENCES skus(sku),
  buyer_name       TEXT,
  buyer_email      TEXT,
  ship_to_json     TEXT,                           -- {name,address_line_1,admin_area_2,admin_area_1,postal_code,country_code}
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  status           TEXT NOT NULL,                  -- CREATED|APPROVED|COMPLETED
  tracking_number  TEXT,
  carrier          TEXT,
  tracker_status   TEXT,                           -- PayPal tracker status (SHIPPED|DELIVERED|...)
  captured_at      TEXT,
  source           TEXT NOT NULL CHECK (source IN ('paypal_sandbox','fixture')),
  raw_json         TEXT
);

CREATE TABLE IF NOT EXISTS disputes (
  id                     TEXT PRIMARY KEY,          -- PP-D-xxxx
  source                 TEXT NOT NULL CHECK (source IN ('paypal_sandbox','fixture')),
  order_id               TEXT REFERENCES orders(id),
  capture_id             TEXT,
  sku                    TEXT REFERENCES skus(sku),
  reason                 TEXT NOT NULL,             -- MERCHANDISE_OR_SERVICE_NOT_RECEIVED | MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED | UNAUTHORISED | ...
  stage                  TEXT,                      -- INQUIRY|CHARGEBACK|PRE_ARBITRATION|ARBITRATION
  status                 TEXT NOT NULL,             -- OPEN|WAITING_FOR_SELLER_RESPONSE|UNDER_REVIEW|RESOLVED|...
  outcome                TEXT,                      -- RESOLVED_BUYER_FAVOUR|RESOLVED_SELLER_FAVOUR|...
  amount_cents           INTEGER NOT NULL,
  currency               TEXT NOT NULL,
  seller_response_due_at TEXT,
  pp_created_at          TEXT,
  pp_updated_at          TEXT,
  last_synced_at         TEXT NOT NULL,
  strength_score         INTEGER,                   -- latest run, 0..100
  recommendation         TEXT,                      -- FIGHT|ACCEPT_CLAIM|MAKE_OFFER
  raw_json               TEXT NOT NULL              -- full GET /v1/customer/disputes/{id}
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_sku_reason ON disputes(sku, reason);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                  TEXT PRIMARY KEY,             -- PayPal event id, or 'demo_<nanoid>' / 'poll_<nanoid>'
  source              TEXT NOT NULL CHECK (source IN ('paypal','demo_trigger','poll')),
  event_type          TEXT NOT NULL,
  resource_id         TEXT,                         -- dispute id
  verified            INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT,                         -- SUCCESS|FAILURE|N/A
  received_at         TEXT NOT NULL,
  processed_at        TEXT,
  raw_json            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                  TEXT PRIMARY KEY,
  dispute_id          TEXT NOT NULL REFERENCES disputes(id),
  trigger_event_id    TEXT REFERENCES webhook_events(id),
  status              TEXT NOT NULL CHECK (status IN ('queued','running','draft_ready','failed','submitted','conceded')),
  clock_started_at    TEXT NOT NULL,                -- = webhook_events.received_at of trigger
  started_at          TEXT,
  draft_ready_at      TEXT,
  finished_at         TEXT,                         -- PayPal 2xx on approved action
  model_agent         TEXT NOT NULL,
  model_review        TEXT,
  classification_json TEXT,                         -- {reason, sub_theme, evidence_needed[], confidence_note}
  strength_json       TEXT,                         -- {score, items:[{key,label,weight,present,source_ids[]}]}
  ev_json             TEXT,                         -- {inputs, options:[{action, expected_cost_cents, formula}], recommended}
  recommendation      TEXT,
  draft_json          TEXT,                         -- {sentences:[{id,text,source_ids[]}], removed:[{id,text,reason}]}
  evidence_plan_json  TEXT,                         -- [{evidence_type, evidence_info?, notes}]
  review_applied      INTEGER NOT NULL DEFAULT 0,
  citation_check_json TEXT,                         -- {rounds, passed, failures[]}
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  error               TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_run
  ON agent_runs(dispute_id) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS agent_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES agent_runs(id),
  seq         INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('info','tool_call','tool_result','check','decision','review','error')),
  label       TEXT NOT NULL,                        -- human line shown in trace
  payload_json TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS sources (
  run_id     TEXT NOT NULL REFERENCES agent_runs(id),
  source_key TEXT NOT NULL,                         -- 'S1','S2',...
  kind       TEXT NOT NULL CHECK (kind IN ('dispute_field','order_field','capture_field','tracking_event','buyer_message','seller_message','policy_clause','sku_field')),
  title      TEXT NOT NULL,                         -- "Tracker 9400… status DELIVERED"
  content    TEXT NOT NULL,                         -- exact text the checker matches against
  ref        TEXT,                                  -- API path or message id / policy anchor
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (run_id, source_key)
);

CREATE TABLE IF NOT EXISTS decisions (
  id          TEXT PRIMARY KEY,
  dispute_id  TEXT NOT NULL REFERENCES disputes(id),
  run_id      TEXT REFERENCES agent_runs(id),
  action      TEXT NOT NULL CHECK (action IN ('submit_evidence','accept_claim','make_offer','send_message')),
  payload_json TEXT NOT NULL,
  result      TEXT NOT NULL CHECK (result IN ('pending','success','failed')),
  paypal_call_id INTEGER REFERENCES paypal_calls(id),
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paypal_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id    TEXT,
  run_id        TEXT,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status_code   INTEGER,
  debug_id      TEXT,                               -- 'paypal-debug-id' response header
  duration_ms   INTEGER,
  error_name    TEXT,
  error_message TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patterns (
  id             TEXT PRIMARY KEY,
  sku            TEXT REFERENCES skus(sku),
  reason         TEXT NOT NULL,
  theme          TEXT NOT NULL,                     -- closed list from themes.ts
  dispute_count  INTEGER NOT NULL,                  -- disputes in (sku,reason) group
  matching_count INTEGER NOT NULL,                  -- disputes with >=1 message tagged theme
  quotes_json    TEXT NOT NULL,                     -- [{dispute_id, message_ref, quote}]
  headline       TEXT NOT NULL,                     -- "4 of 6 SNAD claims on JT-114 mention sizing"
  action         TEXT NOT NULL,                     -- "Update the size chart for JT-114"
  includes_fixture INTEGER NOT NULL,
  computed_at    TEXT NOT NULL
);
```

---

## 6. API endpoints

Every route uses `runtime = 'nodejs'`. Error shape for all routes: `{ error: { code: string, message: string, debug_id?: string } }`. PayPal-mutating routes return `422 FIXTURE_READ_ONLY` for `source='fixture'` disputes and `409 INVALID_STATE` when the PayPal status does not allow the action.

### 6.1 Inbound from PayPal

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/webhooks/paypal` | Raw PayPal event body plus headers `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url`, `paypal-auth-algo` | `200 {received:true, event_id}`, duplicate `200 {duplicate:true}`, failed verification `400 {error:{code:'SIGNATURE_INVALID'}}` |

The handler: (1) `await req.text()`; (2) verify through `POST /v1/notifications/verify-webhook-signature` with body `{"auth_algo":…,"cert_url":…,"transmission_id":…,"transmission_sig":…,"transmission_time":…,"webhook_id":PAYPAL_WEBHOOK_ID,"webhook_event":<RAW BODY SPLICED>}`; (3) insert the event; (4) for `CUSTOMER.DISPUTE.CREATED`, and for `UPDATED` where the status became `WAITING_FOR_SELLER_RESPONSE` and no run exists, call `enqueueRun`; for `RESOLVED`, sync the outcome only; (5) return.

### 6.2 Disputes and agent

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/disputes` | query `?status=&reason=&sku=` | `200 {disputes: DisputeRow[]}` where `DisputeRow = {id, source, reason, status, stage, amount_cents, currency, sku, sku_name, buyer_name, seller_response_due_at, strength_score, recommendation, latest_run:{id,status,draft_ready_ms,submitted_ms}|null}` |
| POST | `/api/disputes/sync` | `{}` | `200 {synced:number, new_runs:string[]}` |
| GET | `/api/disputes/:id` | n/a | `200 {dispute, order, sku, run, steps:Step[], sources:Source[], decisions:Decision[], paypal_calls:Call[]}` |
| POST | `/api/disputes/:id/run` | `{force?:boolean}` | `202 {run_id}`, or `409 RUN_ACTIVE` |
| GET | `/api/disputes/:id/stream?run=<runId>` | SSE (`text/event-stream`) | Events: `step` `{seq,kind,label,payload,duration_ms,created_at}`, `status` `{status, draft_ready_at?, finished_at?}`, `done` `{}`. Sends the stored backlog first, then live bus events. Heartbeat `:ping` every 15 s. |
| GET | `/api/disputes/:id/pdf?run=<runId>` | n/a | `200 application/pdf` (the same bytes that would be submitted) |
| POST | `/api/disputes/:id/approve` | `{run_id, edited_sentences?: {id,text}[]}`. Edited sentences go through the citation check again and the route returns `422 CITATION_FAILED` if any fail | `200 {decision_id, status:'submitted', paypal:{status_code, debug_id}, elapsed_ms}`, or `502 {error, debug_id}` |
| POST | `/api/disputes/:id/concede` | `{run_id, action:'accept_claim'|'make_offer', note:string, offer_amount_cents?:number, offer_type?:'REFUND'|'REFUND_WITH_RETURN'|'REFUND_WITH_REPLACEMENT'}` | `200 {decision_id, paypal:{status_code, debug_id}}` |
| POST | `/api/disputes/:id/message` | `{message:string}` (max 2000 chars) | `200 {decision_id, paypal:{status_code, debug_id}}` |
| POST | `/api/disputes/:id/simulate` | `{action:'require_evidence', evidence_for:'SELLER_EVIDENCE'|'BUYER_EVIDENCE'}` or `{action:'adjudicate', outcome:'SELLER_FAVOR'|'BUYER_FAVOR'}` | `200 {paypal:{status_code, debug_id}, dispute_status}`. `403` unless `PAYPAL_ENV=sandbox` |

### 6.3 Demo, patterns, observability

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/demo/pool` | n/a | `200 {available:number, disputes:[{id,reason,amount_cents}]}` |
| POST | `/api/demo/trigger` | `{}`. Rate-limited per IP and globally (`ratelimit.ts`, in-memory token bucket) | `202 {run_id, dispute_id, event_id, source:'demo_trigger'}`, `409 POOL_EMPTY`, `429 RATE_LIMITED` |
| GET | `/api/patterns` | n/a | `200 {patterns: Pattern[], computed_at}` |
| POST | `/api/patterns/recompute` | `{}` | `200 {patterns: Pattern[]}` |
| GET | `/api/paypal-calls` | `?dispute_id=` | `200 {calls: Call[]}` (Activity page: every PayPal call with its `debug_id`) |
| GET | `/api/health` | n/a | `200 {ok:true, paypal_env, mock:{paypal,anthropic}, db:'ok', webhook_id_set:boolean}` |

### 6.4 Storefront

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/store/orders` | `{sku:string}` | `200 {id}` (PayPal order id). Server-side `POST /v2/checkout/orders` with `intent:'CAPTURE'`, `purchase_units[0].reference_id=sku`, `items[]` and `shipping` preference `GET_FROM_FILE` |
| POST | `/api/store/orders/:orderId/capture` | `{}` | `200 {order_id, capture_id, status}`. Calls `POST /v2/checkout/orders/{id}/capture`, stores the order and immediately calls `trackers-batch` with a fixture tracking number (status `SHIPPED`) |

### 6.5 Outbound PayPal calls (all inside `src/lib/paypal/*`, base `https://api-m.sandbox.paypal.com`)

| Purpose | Call |
|---|---|
| Token | `POST /v1/oauth2/token` (`grant_type=client_credentials`, Basic auth). Cached until `expires_in − 60s` |
| List disputes | `GET /v1/customer/disputes?update_time_after=…&page_size=50` |
| Show dispute | `GET /v1/customer/disputes/{id}` |
| Provide evidence | `POST /v1/customer/disputes/{id}/provide-evidence` as `multipart/form-data`: part `input` (`application/json`, `{"evidences":[{"evidence_type":"…","evidence_info":{"tracking_info":[{"carrier_name":"USPS","tracking_number":"…"}]},"notes":"…","documents":[{"name":"evidence-<id>.pdf"}]}]}`) plus part `file1` (`application/pdf`, filename `evidence-<id>.pdf`). Built with the Web `FormData` + `Blob` in `multipart.ts` |
| Accept claim | `POST /v1/customer/disputes/{id}/accept-claim` `{note, accept_claim_type:'REFUND'}` |
| Make offer | `POST /v1/customer/disputes/{id}/make-offer` `{note, offer_amount:{currency_code,value}, offer_type}` |
| Send message | `POST /v1/customer/disputes/{id}/send-message` (multipart, part `input` = `{"message":"…"}`) |
| Sandbox: require evidence | `POST /v1/customer/disputes/{id}/require-evidence` `{action:'SELLER_EVIDENCE'}` |
| Sandbox: adjudicate | `POST /v1/customer/disputes/{id}/adjudicate` `{adjudication_outcome:'SELLER_FAVOR'|'BUYER_FAVOR'}` |
| Capture lookup | `GET /v2/payments/captures/{capture_id}` → `supplementary_data.related_ids.order_id` |
| Order lookup | `GET /v2/checkout/orders/{id}` |
| Add tracking | `POST /v1/shipping/trackers-batch` `{trackers:[{transaction_id, tracking_number, status:'SHIPPED', carrier}]}` |
| Get tracking | `GET /v1/shipping/trackers/{transaction_id}-{tracking_number}` |
| Register webhook | `POST /v1/notifications/webhooks` |
| Verify webhook | `POST /v1/notifications/verify-webhook-signature` |

### 6.6 Agent contract (`src/lib/agent/*`)

**Tools given to Claude.** All are read-only. Each returns `{source_key, title, content}` and stores a `sources` row.

| Tool | Input | Backed by |
|---|---|---|
| `get_dispute` | `{dispute_id}` | Show dispute → sources for reason, amount, due date, buyer-claimed facts |
| `get_transaction` | `{capture_id}` | Capture → order → line items, ship-to address, capture time |
| `get_tracking` | `{capture_id}` | PayPal tracker plus `carrier/adapter.ts` events (each event is its own source, labeled "Carrier fixture" when it comes from the fixture provider) |
| `get_messages` | `{dispute_id}` | `dispute.messages[]`, one source per message, with `posted_by` and `time_posted` |
| `get_policy` | `{slug:'returns'|'shipping'|'size-guide'}` | Policy markdown, one source per clause, including `published_at` |
| `get_sku` | `{sku}` | SKU description and size-chart version |
| `score_evidence` | `{}` | Runs `strength.ts` over the sources collected so far (deterministic) |
| `compute_expected_value` | `{}` | Runs `expected-value.ts` (deterministic) |
| `submit_analysis` | Schema below | Terminal tool. Current Sonnet/Opus models reject forced `tool_choice`, so it is requested in the prompt with `tool_choice:auto`; at turn 10 (or 70 s) the runner appends a "submit now" instruction. A malformed call is returned to the model with the zod errors |

The `submit_analysis` input is validated with zod in `schemas.ts`:

```ts
{
  classification: { reason: ReasonCode; sub_theme: string; evidence_needed: string[] },
  recommendation: 'FIGHT' | 'ACCEPT_CLAIM' | 'MAKE_OFFER',   // must equal EV tool's recommended unless rationale cites why
  recommendation_rationale: { text: string; source_ids: string[] }[],
  evidence_plan: { evidence_type: EvidenceType; notes: string; tracking_number?: string; carrier?: string }[],
  sentences: { id: string; text: string; source_ids: string[] }[],          // the response letter
  buyer_message?: { text: string; source_ids: string[] }                    // optional courteous reply
}
```

**Loop limits:** at most 12 model turns, a 90 s wall-clock budget, and each step written before it is emitted. On any error the run is marked `failed`, the error step is shown in the trace, and the UI offers "Retry run".

**Citation check (`citations.ts`), pure function:** `checkSentences(sentences, sourcesByKey) → {passed: Sentence[], failed: {id, text, reason: 'NO_CITATION'|'UNKNOWN_SOURCE'|'UNGROUNDED_TOKEN', token?}[]}`. Grounded tokens are extracted with regexes for numbers and money (`\$?\d[\d,]*(\.\d+)?`), ISO and natural dates, tracking-like strings (`[A-Z0-9]{10,}`) and anything in double quotes. Each one must appear, normalized for case and whitespace, in the `content` of at least one cited source.

**Evidence rules (`evidence-rules.ts`)** are the single typed map from reason code to allowed `evidence_type` values. The submission service rejects anything outside it:

- `MERCHANDISE_OR_SERVICE_NOT_RECEIVED` → `PROOF_OF_FULFILLMENT` (with `tracking_info`), `PROOF_OF_DELIVERY_SIGNATURE`, `OTHER`
- `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED` → `ITEM_DESCRIPTION`, `RETURN_POLICY`, `PROOF_OF_FULFILLMENT`, `OTHER`
- `UNAUTHORISED` → `PROOF_OF_FULFILLMENT`, `PROOF_OF_DELIVERY_SIGNATURE`, `OTHER`
- Any other reason → `OTHER`

Confirm these against the sandbox in hours 1–4. This file is the only place to correct them.

**Strength rubric (`strength.ts`).** Weights sum to 100 for each reason code:

- **INR:** tracking attached in PayPal (25), carrier shows delivered (30), delivery ZIP matches order ship-to (20), signature captured (15), shipped before buyer's claim date (10).
- **SNAD:** listing description matches the delivered SKU (25), policy published before purchase (20), buyer thread shows seller responded in under 48 h (15), offered return per policy (20), no prior SNAD on this SKU in 90 days (20).
- **UNAUTHORISED:** delivered to the PayPal-verified ship-to (35), signature (25), prior non-disputed orders from the same buyer (20), delivery confirmed (20).

Each item reports `{present, source_ids}`.

**Expected value (`expected-value.ts`).** `A` = disputed amount, `F` = `DISPUTE_FEE_USD`, `T` = `SELLER_TIME_COST_USD`, `C` = SKU COGS, `s` = strength/100. The UI labels `s` "strength used as a rough win proxy, not a trained probability".

- Fight: `cost = (1 − s)·(A + F) + T`
- Accept claim: `cost = A + F`. If the return goes back to the seller, `− C·0.5`, labeled "half resale value of returned item"
- Make offer at `o·A` (the model proposes `o ∈ {0.3, 0.5}`): `cost = o·A + F·0.5`, labeled "assumes buyer accepts the offer"

Recommended = the option with the lowest cost. All formulas are returned as strings with their values filled in and displayed exactly.

---

## 7. Implementation order (fastest path to a working end-to-end demo)

Each phase ends with something that runs. The feature freeze is at **hour 38**.

**Phase 0 (h0–1): skeleton and safety**
`create-next-app` with the pinned versions, `LICENSE` (MIT), `.gitignore`, `.env.example`, gitleaks pre-commit, `src/lib/env.ts` (zod, fails fast), `db.ts` plus `schema.sql`, `/api/health`. Push the public repo.

**Phase 1 (h1–4): first PayPal milestone (de-risk `provide-evidence`)**
`paypal/client.ts` (token cache and `debug_id` logging), `paypal/disputes.ts`, `multipart.ts`, `evidence-rules.ts`, `scripts/make-static-evidence.ts`, `scripts/smoke-provide-evidence.ts`. Stage **one** real sandbox dispute by hand (`docs/sandbox-staging.md`) and get a `200` from provide-evidence with the static PDF. **Gate: no AI work starts until this returns 200.**

**Phase 2 (h4–8): real data in, trigger out**
Storefront (`store/page.tsx`, `Checkout.tsx`, store order and capture routes, trackers-batch on capture), `seed-store.ts`, `register-webhook.ts`, the webhook route with verification, `sync.ts` and the instrumentation poller, `repo/*`. Stage about 6 real disputes (2 per reason). **Milestone: dispute opened in sandbox → webhook stored as verified → static PDF submitted through `/approve`. This alone is a valid submission.**

**Phase 3 (h8–20): the agent**
`agent/tools.ts` with sources, `runner.ts` with steps written to the DB and bus, the SSE `stream` route, `useDisputeStream`, `AgentTrace` and `Stopwatch` (two readouts: *draft ready* = `draft_ready_at − clock_started_at`, *submitted* = `finished_at − clock_started_at`, the latter labeled "includes your approval time"), `playbooks.ts` and `prompts.ts`, `citations.ts` with the repair loop, `pdf/EvidencePacket.tsx` with citation footnotes, `DraftResponse`, `CitationChip`, `SourceDrawer`, `RemovedSentences`, and `/approve` running through `submit.ts` guards. Unit tests: citations, multipart, evidence rules, submit guards, webhook verify body.

**Phase 4 (h20–30): decision and inbox**
`strength.ts`, `expected-value.ts`, `StrengthBreakdown` (hover or tap breakdown), `DecisionPanel` and `ExpectedValueMath`, `/concede` (accept-claim and make-offer), `/message`, `/simulate` with `SandboxControls`. AG Grid inbox: `DisputeGrid` with deadline, status, strength, amount, reason and recommendation renderers, the code-side group-by select with `GroupHeaderRow`, the `TraceDetailRow` full-width expand, quick filter, a pinned totals row ("$ at risk", "due in < 48 h"), and CSV export. Demo trigger plus pool route plus rate limit. Unit tests: strength and EV.

**Phase 5 (h30–38): prevention, polish, deploy**
Fixture history load, `patterns/themes.ts` (closed list: `sizing`, `color_mismatch`, `fabric_quality`, `late_delivery`, `wrong_item`, `damaged`, `not_recognized`), `mine.ts` (Claude tags, code counts, quote substring check), the Patterns page with `PatternsGrid` and `PatternCard`, the Opus `review.ts` pass, the Activity page (every PayPal call with its `debug_id`), designed empty, loading, error and resolved states, a mobile pass on the detail view, Render deploy with `render.yaml`, re-registering the webhook to the Render URL, the Postman collection, and the README (Mermaid architecture diagram, setup, ngrok, tools disclosure). Integration tests with `PAYPAL_MOCK=1 ANTHROPIC_MOCK=1` and the Playwright `demo-loop.spec.ts` in mock mode.

**Phase 6 (h38–48): feature freeze → submission**
Restock the dispute pool (at least 4 staged), record 3 full takes following `docs/demo-runbook.md` and use the best take with its **real measured** times, make the README GIF, write the Devpost text in the same order as the video, and do final checks: LICENSE visible in About, no secrets (`gitleaks detect`), hosted URL tested from a clean browser.

**Not in scope (deliberately cut):** multi-seller auth, a live carrier API (only the adapter interface and a README note on EasyPost/Shippo test mode), Postgres, AG Grid Enterprise, auto-submission of any kind.