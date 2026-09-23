# Phase 3: Production Blockers & Gateway Abstraction Design Document

**Date:** 2026-08-24  
**Status:** Approved  
**Scope:** Downstream Webhook Delivery, Payment Gateway Adapter Interface, Refund API, Database Transactions, and Automated Rate-Bucket Pruning.

---

## 1. Objectives

1. **Downstream Webhook Delivery**: Store `webhook_url` per product, and asynchronously dispatch `payment.paid` HMAC-signed notifications to downstream product servers when payments settle.
2. **Pluggable Gateway Abstraction (`PaymentGatewayAdapter`)**: Abstract gateway calls into `RazorpayGateway` and `DevGateway` implementing `createOrder`, `verifyPayment`, and `refundPayment`.
3. **Refund API (`POST /v1/refunds`)**: Support full and partial payment refunds via gateway adapters and record refund history.
4. **Database Transaction Boundaries (`transaction()`)**: Support atomic multi-statement database operations across SQLite, Cloudflare D1, and PostgreSQL adapters.
5. **Rate Bucket & Audit Log Pruning**: Add utility functions to purge expired rate buckets and old audit logs.

---

## 2. Component Design & Specifications

### A. Schema Migrations (`migrations/0003_webhooks_and_gateways.sql`)
```sql
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
```

### B. Gateway Adapter Interface (`src/gateways/adapter.ts`)
```ts
export interface CreateOrderOpts {
  amountPaise: number
  currency: string
  receipt: string
  notes?: Record<string, string>
}

export interface VerifyPaymentOpts {
  orderId: string
  paymentId: string
  signature: string
}

export interface RefundOpts {
  paymentId: string
  razorpayPaymentId?: string
  amountPaise: number
  reason?: string
}

export interface PaymentGatewayAdapter {
  name: string
  createOrder(opts: CreateOrderOpts): Promise<{ ok: true; orderId: string; raw: unknown } | { ok: false; error: string }>
  verifyPayment(opts: VerifyPaymentOpts): Promise<boolean>
  refundPayment(opts: RefundOpts): Promise<{ ok: true; refundId: string; raw: unknown } | { ok: false; error: string }>
}
```

### C. Downstream Webhook Dispatcher (`src/core/webhook-dispatcher.ts`)
When a payment is confirmed paid (`/v1/verify` or `/v1/webhooks/razorpay`):
- Read `webhook_url` and `webhook_secret` for the product.
- Compute HMAC-SHA256 signature of body using `webhook_secret`.
- Send POST request with headers `X-PayDeck-Signature` and `X-PayDeck-Event: payment.paid`.

### D. Transaction Support (`src/db/adapter.ts`)
Add `transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>` to `DatabaseAdapter`.
