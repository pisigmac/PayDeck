# Phase 5: Stripe Gateway, Subscriptions, Web Worker & Admin UI Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Scope:** Stripe Gateway Adapter, Automated Webhook Background Cron Worker, Subscriptions Domain & Renewal Engine, Multi-Admin RBAC, and Web Admin Dashboard UI.

---

## 1. Objectives

1. **Stripe Gateway Adapter (`StripeGatewayAdapter`)**: Native support for Stripe PaymentIntents and Refunds via REST API.
2. **Automated Webhook Background Cron Worker**: Background periodic processing of pending downstream webhook retries (`src/core/webhook-worker.ts`) mounted in Node.js and Bun entrypoints.
3. **Subscriptions & Renewal Engine (`subscriptions` table)**: Full subscription entity lifecycle (`active`, `past_due`, `canceled`) with creation, cancellation, and renewal helper functions.
4. **Multi-Admin RBAC & Authentication**: Hashed admin users table (`admin_users`) with admin login (`POST /v1/admin/login`) and session token support alongside static admin token.
5. **Web Admin Dashboard UI**: Visual Single-Page Application (SPA) dashboard in `public/admin/index.html` for product, key, plan, customer, refund, audit log, and webhook delivery management.

---

## 2. Component Design & Specifications

### A. Database Migrations (`migrations/0005_subscriptions_and_stripe.sql`)
```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE INDEX subscriptions_customer_idx ON subscriptions(customer_id);
CREATE INDEX subscriptions_status_idx ON subscriptions(status, current_period_end);

CREATE TABLE admin_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL
);
```

### B. Stripe Gateway Adapter (`src/gateways/stripe.ts`)
Implements `PaymentGatewayAdapter`:
- `createOrder`: POST to `https://api.stripe.com/v1/payment_intents` with `amount`, `currency`, `description`.
- `verifyPayment`: GET from `https://api.stripe.com/v1/payment_intents/:id`.
- `refundPayment`: POST to `https://api.stripe.com/v1/refunds` with `payment_intent` and `amount`.

### C. Webhook Background Worker (`src/core/webhook-worker.ts`)
Starts periodic interval calling `processWebhookDeliveries(db)` every 60,000 ms.

### D. Subscriptions Domain (`src/core/subscriptions.ts` & `src/routes/billing.ts`)
- `POST /v1/subscriptions`: Create a new subscription linked to a customer and plan.
- `GET /v1/subscriptions`: List product subscriptions with pagination.
- `POST /v1/subscriptions/:id/cancel`: Cancel subscription immediately or at period end.

### E. Web Admin Dashboard UI (`public/admin/index.html`)
HTML5/CSS3/Vanilla JS single-page app providing visual tabs for:
- **Products & Plans**
- **API Keys**
- **Customers**
- **Payments & Refunds**
- **Audit Logs**
- **Webhook Queue & Manual Redelivery**
