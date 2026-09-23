CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_status_idx ON webhook_deliveries(status, next_retry_at);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  external_user_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS customers_product_ext_idx ON customers(product_id, external_user_id);

ALTER TABLE payments ADD COLUMN customer_id TEXT;
