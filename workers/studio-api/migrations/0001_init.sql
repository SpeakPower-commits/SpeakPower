CREATE TABLE IF NOT EXISTS studio_products (
  product_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  amount_ugx INTEGER NOT NULL CHECK (amount_ugx > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

INSERT OR REPLACE INTO studio_products (product_key, title, amount_ugx, active) VALUES
  ('brand-story', 'Brand Story Builder', 100000, 1),
  ('seo-audit', 'Website SEO & Visibility Audit', 75000, 1),
  ('market-plan', 'Market Development Planner', 125000, 1),
  ('content-seo', 'SEO Content Starter', 75000, 1),
  ('data-story', 'Data Story Builder', 100000, 1),
  ('speaker-ready', 'Speaker Ready Pack', 75000, 1);

CREATE TABLE IF NOT EXISTS studio_users (
  clerk_user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS studio_orders (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  product_key TEXT NOT NULL REFERENCES studio_products(product_key),
  amount_ugx INTEGER NOT NULL CHECK (amount_ugx > 0),
  currency TEXT NOT NULL DEFAULT 'UGX',
  tx_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','cancelled')),
  flutterwave_transaction_id TEXT,
  checkout_url TEXT,
  provider_payload TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS studio_runs (
  id TEXT PRIMARY KEY,
  clerk_user_id TEXT NOT NULL,
  product_key TEXT NOT NULL REFERENCES studio_products(product_key),
  run_type TEXT NOT NULL CHECK (run_type IN ('trial','paid')),
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','completed','failed')),
  order_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reserved_until TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS studio_runs_user_type_idx
  ON studio_runs(clerk_user_id, run_type, status);

CREATE INDEX IF NOT EXISTS studio_orders_user_product_idx
  ON studio_orders(clerk_user_id, product_key, status, created_at);

CREATE INDEX IF NOT EXISTS studio_orders_tx_ref_idx
  ON studio_orders(tx_ref);

CREATE VIEW IF NOT EXISTS studio_unused_paid_orders AS
SELECT
  o.id AS order_id,
  o.clerk_user_id,
  o.product_key,
  o.amount_ugx,
  o.paid_at
FROM studio_orders o
WHERE o.status = 'paid'
  AND NOT EXISTS (
    SELECT 1
    FROM studio_runs r
    WHERE r.order_id = o.id
      AND r.status IN ('reserved', 'completed')
  );
