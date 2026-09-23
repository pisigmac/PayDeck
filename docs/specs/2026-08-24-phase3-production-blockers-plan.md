# Phase 3: Production Blockers & Gateway Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement pluggable gateway adapters (Razorpay/Dev), downstream product webhook dispatching with HMAC signatures, refund processing (`POST /v1/payments/:id/refund`), DB transactions, and automated rate bucket pruning.

**Architecture:** Payment gateway calls pass through `PaymentGatewayAdapter` interface. Payments marked `paid` automatically trigger background downstream webhook HTTP POSTs with HMAC-SHA256 signatures (`X-PayDeck-Signature`). Multi-statement DB ops run inside `transaction()`.

**Tech Stack:** TypeScript, Hono, Vitest, Web Crypto.

---

## File Structure

- **`migrations/0003_webhooks_and_gateways.sql`**: Database migration for `webhook_url`, `webhook_secret`, and `refunds` table.
- **`src/gateways/adapter.ts`**: Defines `PaymentGatewayAdapter` interface & types.
- **`src/gateways/razorpay.ts`**: Razorpay gateway implementation.
- **`src/gateways/dev.ts`**: Dev mode fake gateway implementation.
- **`src/core/webhook-dispatcher.ts`**: Dispatches signed webhooks to product URLs on payment events.
- **`src/core/prune.ts`**: Automated cleanup for expired rate buckets and old audit logs.
- **`src/routes/billing.ts` & `src/routes/admin.ts`**: Updated to handle refunds, webhook dispatching, and transaction boundaries.

---

### Task 1: Gateway Adapter Interface & Implementations

**Files:**
- Create: `src/gateways/adapter.ts`
- Create: `src/gateways/razorpay.ts`
- Create: `src/gateways/dev.ts`
- Test: `tests/gateway.test.ts`

- [ ] **Step 1: Write test for Gateway Adapters**

Create `tests/gateway.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { DevGatewayAdapter } from '../src/gateways/dev'

describe('DevGatewayAdapter', () => {
  it('creates order and refunds payment in dev mode', async () => {
    const dev = new DevGatewayAdapter()
    const order = await dev.createOrder({ amountPaise: 500, currency: 'INR', receipt: 'rcpt_1' })
    expect(order.ok).toBe(true)
    if (order.ok) {
      expect(order.orderId).toContain('order_dev_')
    }

    const refund = await dev.refundPayment({ paymentId: 'pay_1', amountPaise: 500 })
    expect(refund.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/gateways/dev'".

- [ ] **Step 3: Implement Gateway Adapters**

Create `src/gateways/adapter.ts`:
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
  createOrder(opts: CreateOrderOpts): Promise<{ ok: true; orderId: string; raw?: unknown } | { ok: false; error: string }>
  verifyPayment(opts: VerifyPaymentOpts): Promise<boolean>
  refundPayment(opts: RefundOpts): Promise<{ ok: true; refundId: string; raw?: unknown } | { ok: false; error: string }>
}
```

Create `src/gateways/dev.ts`:
```ts
import { newId } from '../crypto'
import type { PaymentGatewayAdapter, CreateOrderOpts, VerifyPaymentOpts, RefundOpts } from './adapter'

export class DevGatewayAdapter implements PaymentGatewayAdapter {
  name = 'dev'

  async createOrder(opts: CreateOrderOpts) {
    const orderId = `order_dev_${newId('ord').slice(-16)}`
    return { ok: true as const, orderId, raw: { id: orderId, amount: opts.amountPaise } }
  }

  async verifyPayment(opts: VerifyPaymentOpts) {
    return opts.signature === 'dev' || opts.orderId.startsWith('order_dev_')
  }

  async refundPayment(opts: RefundOpts) {
    const refundId = `rfnd_dev_${newId('rfnd').slice(-16)}`
    return { ok: true as const, refundId, raw: { id: refundId, amount: opts.amountPaise } }
  }
}
```

Create `src/gateways/razorpay.ts`:
```ts
import { createRazorpayOrder, verifyPaymentSignature } from '../razorpay'
import type { PaymentGatewayAdapter, CreateOrderOpts, VerifyPaymentOpts, RefundOpts } from './adapter'

export class RazorpayGatewayAdapter implements PaymentGatewayAdapter {
  name = 'razorpay'
  private keyId: string
  private keySecret: string

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId
    this.keySecret = keySecret
  }

  async createOrder(opts: CreateOrderOpts) {
    const res = await createRazorpayOrder({
      keyId: this.keyId,
      keySecret: this.keySecret,
      amountPaise: opts.amountPaise,
      currency: opts.currency,
      receipt: opts.receipt,
      notes: opts.notes,
    })
    if (!res.ok) return { ok: false as const, error: res.error }
    return { ok: true as const, orderId: String(res.order.id), raw: res.order }
  }

  async verifyPayment(opts: VerifyPaymentOpts) {
    return verifyPaymentSignature(this.keySecret, opts.orderId, opts.paymentId, opts.signature)
  }

  async refundPayment(opts: RefundOpts) {
    if (!opts.razorpayPaymentId) return { ok: false as const, error: 'missing_razorpay_payment_id' }
    try {
      const auth = 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')
      const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(opts.razorpayPaymentId)}/refund`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: opts.amountPaise,
          notes: { reason: opts.reason || 'Requested by customer' },
        }),
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) return { ok: false as const, error: String(json.error?.description || res.statusText) }
      return { ok: true as const, refundId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 2: Downstream Webhook Delivery Dispatcher

**Files:**
- Create: `migrations/0003_webhooks_and_gateways.sql`
- Create: `src/core/webhook-dispatcher.ts`
- Test: `tests/webhook-dispatcher.test.ts`

- [ ] **Step 1: Write test for Webhook Dispatcher**

Create `tests/webhook-dispatcher.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { dispatchDownstreamWebhook } from '../src/core/webhook-dispatcher'

describe('dispatchDownstreamWebhook', () => {
  it('dispatches HMAC-signed HTTP POST to product webhook URL', async () => {
    let capturedBody = ''
    let capturedHeader = ''
    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = String(init?.body)
      capturedHeader = String((init?.headers as Record<string, string>)?.['X-PayDeck-Signature'])
      return new Response('OK', { status: 200 })
    }

    const res = await dispatchDownstreamWebhook(
      {
        webhookUrl: 'https://example.com/webhooks',
        webhookSecret: 'secret_123',
        event: 'payment.paid',
        data: { payment_id: 'pay_1', amount_paise: 500 },
      },
      mockFetch as typeof fetch,
    )

    expect(res.ok).toBe(true)
    expect(capturedBody).toContain('payment.paid')
    expect(capturedHeader.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: Create migration & implementation**

Create `migrations/0003_webhooks_and_gateways.sql`:
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

Create `src/core/webhook-dispatcher.ts`:
```ts
import { hmacSha256Hex } from '../crypto'

export interface DispatchWebhookOpts {
  webhookUrl: string
  webhookSecret?: string | null
  event: string
  data: Record<string, unknown>
}

export async function dispatchDownstreamWebhook(
  opts: DispatchWebhookOpts,
  fetchFn = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!opts.webhookUrl) return { ok: false, error: 'no_webhook_url' }

  const payload = JSON.stringify({
    event: opts.event,
    timestamp: new Date().toISOString(),
    data: opts.data,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-PayDeck-Event': opts.event,
  }

  if (opts.webhookSecret) {
    const sig = await hmacSha256Hex(opts.webhookSecret, payload)
    headers['X-PayDeck-Signature'] = sig
  }

  try {
    const res = await fetchFn(opts.webhookUrl, {
      method: 'POST',
      headers,
      body: payload,
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 3: Refund API & Database Operations

**Files:**
- Modify: `src/routes/billing.ts`
- Modify: `src/routes/admin.ts`
- Test: `tests/refunds.test.ts`

- [ ] **Step 1: Write test for Refund API**

Create `tests/refunds.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Refund API', () => {
  it('processes payment refund', async () => {
    // Test refund processing endpoint
  })
})
```

- [ ] **Step 2: Add refund endpoints in `src/routes/billing.ts` and `src/routes/admin.ts`**
  - `POST /v1/payments/:id/refund` (Product API Key authentication)
  - `POST /v1/admin/payments/:id/refund` (Admin authentication)
  - Updates payment status to `refunded` or `partially_refunded` and records row in `refunds` table.

- [ ] **Step 3: Run `npm test` and `npm run typecheck`**

---

### Task 4: Database Adapter Transaction Support

**Files:**
- Modify: `src/db/adapter.ts`
- Modify: `src/db/sqlite.ts`
- Modify: `src/db/d1.ts`
- Test: `tests/db-transaction.test.ts`

- [ ] **Step 1: Update `DatabaseAdapter` interface in `src/db/adapter.ts` to include `transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>`**
- [ ] **Step 2: Implement transaction in `src/db/sqlite.ts` and `src/db/d1.ts`**
- [ ] **Step 3: Write test in `tests/db-transaction.test.ts` and run `npm test`**

---

### Task 5: Automated Rate Bucket & Audit Log Pruner

**Files:**
- Create: `src/core/prune.ts`
- Test: `tests/prune.test.ts`

- [ ] **Step 1: Create `src/core/prune.ts`**
```ts
import type { DatabaseAdapter } from '../db/adapter'

export async function pruneOldBuckets(db: DatabaseAdapter, retentionHours = 168): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000).toISOString().slice(0, 13)
  const res = await db.exec(`DELETE FROM rate_buckets WHERE hour_bucket < ?`, [cutoff])
  return res.changes
}

export async function pruneOldAuditLogs(db: DatabaseAdapter, retentionDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString()
  const res = await db.exec(`DELETE FROM audit_logs WHERE created_at < ?`, [cutoff])
  return res.changes
}
```

- [ ] **Step 2: Create `tests/prune.test.ts` and run `npm test`**

---

### Task 6: Final Verification & Integration Test Suite

- [ ] **Step 1: Execute `npm run build`**
- [ ] **Step 2: Execute `npm run typecheck`**
- [ ] **Step 3: Execute `npm test`**
