ALTER TABLE products ADD COLUMN webhook_url TEXT;
ALTER TABLE products ADD COLUMN webhook_secret TEXT;

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL,
  gateway_refund_id TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'processed',
  created_at TEXT NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE INDEX refunds_payment_idx ON refunds(payment_id);
