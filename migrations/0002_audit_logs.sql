CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  product_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX audit_logs_product_idx ON audit_logs(product_id, created_at);
CREATE INDEX audit_logs_action_idx ON audit_logs(action, created_at);
