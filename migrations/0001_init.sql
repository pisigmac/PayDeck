-- PayDeck spine

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rate_limit_per_hour INTEGER NOT NULL DEFAULT 200,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL DEFAULT 'live', -- live | test
  last_used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX api_keys_prefix_idx ON api_keys(key_prefix);
CREATE INDEX api_keys_product_idx ON api_keys(product_id);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  interval TEXT NOT NULL DEFAULT 'month', -- month | year | one_time
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, slug)
);

CREATE INDEX plans_product_idx ON plans(product_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  api_key_id TEXT,
  plan_id TEXT,
  plan_slug TEXT,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  status TEXT NOT NULL, -- created | paid | failed
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  receipt TEXT,
  notes TEXT, -- JSON
  metadata TEXT, -- JSON
  idempotency_key TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX payments_idempotency_uq
  ON payments(product_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX payments_razorpay_order_uq
  ON payments(razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

CREATE INDEX payments_product_created_idx ON payments(product_id, created_at);
CREATE INDEX payments_status_idx ON payments(status);

CREATE TABLE rate_buckets (
  product_id TEXT NOT NULL,
  hour_bucket TEXT NOT NULL, -- YYYY-MM-DDTHH
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, hour_bucket)
);
