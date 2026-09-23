# Phase 4: Production Resilience & Core Billing Domain Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Scope:** Persistent Webhook Redelivery Queue, Multi-Currency Support, Customer Domain, SDK Auto-Retries & Signature Verifier, and Admin Redelivery APIs.

---

## 1. Objectives

1. **Persistent Webhook Redelivery Queue (`webhook_deliveries`)**: Store all downstream webhook attempts in a persistent database queue with automated exponential backoff retries (1m, 5m, 15m, 1h, 6h, 24h) to eliminate data loss.
2. **Multi-Currency Support**: Unlock ISO-4217 3-letter currency support (`USD`, `EUR`, `GBP`, `SGD`, `INR`, etc.) in validation schemas and gateway adapters.
3. **Customer Entity & Domain (`customers`)**: Introduce `customers` table for tracking customer identities, external user IDs, and linking payments to customers.
4. **SDK Resiliency & Signature Verifier**: Add automatic request retries with backoff and static `verifyWebhookSignature()` helper method to `PayDeckClient`.
5. **Webhook Admin Management APIs**: Add `GET /v1/admin/webhooks` (list deliveries with status filter) and `POST /v1/admin/webhooks/:id/redeliver` (trigger immediate redelivery attempt).

---

## 2. Component Design & Specifications

### A. Schema Migrations (`migrations/0004_webhook_queue_and_multicurrency.sql`)
```sql
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries(status, next_retry_at);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  external_user_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX customers_product_ext_idx ON customers(product_id, external_user_id);

ALTER TABLE payments ADD COLUMN customer_id TEXT;
```

### B. Persistent Webhook Queue Core (`src/core/webhook-queue.ts`)
- `enqueueWebhookDelivery(db, opts)`: Inserts a pending webhook delivery record.
- `processWebhookDeliveries(db, fetchFn)`: Queries deliveries where `status IN ('pending', 'failed') AND next_retry_at <= now() AND attempts < 6`. Sends signed HTTP POST. Updates status to `delivered` or computes backoff for `next_retry_at`.
- Exponential Backoff Delays: `[60, 300, 900, 3600, 21600, 86400]` seconds.

### C. Multi-Currency Validation (`src/schemas.ts`)
Replace strict `refine(c => c === 'INR')` with ISO 3-letter currency validation:
```ts
z.string().trim().length(3).toUpperCase()
```

### D. Customer Domain APIs (`src/routes/billing.ts` & `src/routes/admin.ts`)
- `POST /v1/customers`: Create or update customer record.
- `GET /v1/customers`: List product customers with pagination.
- `GET /v1/customers/:id/payments`: List payments for specific customer.

### E. SDK Enhancements (`src/client.ts`)
- `BillingClientOptions.retries`: number of retries (default 3).
- Automatic retry on HTTP 429, 500, 502, 503, 504, or network exception using exponential delay (`100ms * 2^attempt`).
- `PayDeckClient.verifyWebhookSignature(payload, signature, secret)` static method.
