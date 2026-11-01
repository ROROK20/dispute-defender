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