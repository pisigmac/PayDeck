# PayDeck Cloud — Multi-Tenant Managed SaaS Architecture Design

**Date:** 2026-08-24  
**Status:** Approved  
**Model:** Model A (Managed "PayDeck Cloud" SaaS Subscription)  
**Target Scope:** Multi-tenant organization isolation (`organizations` table), user authentication (`cloud_users` table), usage tier enforcement (Free / Starter / Pro / Business), and Cloud Admin APIs.

---

## 1. Objectives

1. **Multi-Tenant Organization Boundaries (`organizations` table)**:
   - Isolate products, API keys, plans, payments, customers, subscriptions, and webhooks by `org_id`.
   - Support multi-tenant SaaS hosting where 1,000+ independent SaaS founders can sign up and manage billing.

2. **User Authentication & Dashboard Login (`cloud_users` table)**:
   - User Registration (`POST /v1/cloud/signup`) and Login (`POST /v1/cloud/login`).
   - Secure password hashing (SHA-256 with salt) and JWT session tokens (`Bearer token`).

3. **Usage Metering & Tier Limits**:
   - Track monthly order volume per organization (`org_usage_meters`).
   - Enforce tier limits:
     - **Free**: 100 orders/month, 1 product, 2 keys.
     - **Starter ($19/mo)**: 5,000 orders/month, 5 products, 10 keys.
     - **Pro ($49/mo)**: 50,000 orders/month, 20 products, 50 keys.
     - **Business ($149/mo)**: Unlimited orders, unlimited products/keys.

4. **Web Admin Dashboard Multi-Tenant Upgrade (`public/admin/index.html`)**:
   - Upgrade Web Admin SPA to include Tenant Login / Sign-Up modals, Org selection, Usage Meter gauges, and Subscription Upgrade buttons.

---

## 2. Component Specifications

### Database Schema (`migrations/0006_paydeck_cloud_multitenant.sql`)
```sql
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free', -- free | starter | pro | business
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
  month_bucket TEXT NOT NULL, -- e.g. "2026-08"
  order_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, month_bucket)
);

ALTER TABLE products ADD COLUMN org_id TEXT;
CREATE INDEX products_org_idx ON products(org_id);
```

### Authentication & Tenant Endpoints (`src/routes/cloud.ts`)
- `POST /v1/cloud/signup`: Registers `cloud_users` row and default `organizations` row. Returns `{ token, user, org }`.
- `POST /v1/cloud/login`: Validates password hash and returns `{ token, user, org }`.
- `GET /v1/cloud/me`: Returns current user, organization details, current month usage, and tier limits.
- `POST /v1/cloud/org/upgrade`: Simulates or processes tenant subscription tier upgrade (`starter`, `pro`, `business`).
