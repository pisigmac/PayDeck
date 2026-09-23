CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE cloud_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE org_usage_meters (
  org_id TEXT NOT NULL,
  month_bucket TEXT NOT NULL,
  order_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month_bucket)
);

ALTER TABLE products ADD COLUMN org_id TEXT;
CREATE INDEX products_org_idx ON products(org_id);
