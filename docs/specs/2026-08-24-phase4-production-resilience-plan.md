# Phase 4: Production Resilience & Core Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement persistent webhook delivery queue with exponential backoff retries, multi-currency support (USD, EUR, GBP, etc.), customer entity domain, SDK auto-retries, and admin redelivery APIs.

**Architecture:** Webhook deliveries are enqueued into `webhook_deliveries` database table and processed with exponential backoff retries. Customers are tracked in `customers` table and linked to payments. `PayDeckClient` implements automatic retries and HMAC webhook verification.

**Tech Stack:** TypeScript, Hono, Vitest, Web Crypto.

---

## File Structure

- **`migrations/0004_webhook_queue_and_multicurrency.sql`**: Migration for `webhook_deliveries`, `customers`, and `payments.customer_id`.
- **`src/core/webhook-queue.ts`**: Core queue runner supporting `enqueueWebhookDelivery`, `processWebhookDeliveries`, and `redeliverWebhook`.
- **`src/schemas.ts`**: Updated with ISO-4217 multi-currency validation and customer schemas (`CreateCustomerSchema`).
- **`src/routes/billing.ts` & `src/routes/admin.ts`**: Updated with customer CRUD routes, webhook redelivery APIs, and customer payment filters.
- **`src/client.ts`**: Extended with automatic retry logic and `verifyWebhookSignature` helper.

---

### Task 1: Webhook Queue Migration & Core Runner

**Files:**
- Create: `migrations/0004_webhook_queue_and_multicurrency.sql`
- Create: `src/core/webhook-queue.ts`
- Test: `tests/webhook-queue.test.ts`

- [ ] **Step 1: Write test for Webhook Queue Core**

Create `tests/webhook-queue.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { enqueueWebhookDelivery, processWebhookDeliveries } from '../src/core/webhook-queue'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('Webhook Queue Runner', () => {
  it('enqueues and processes webhook delivery with backoff on failure', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE webhook_deliveries (
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
    `)

    await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'payment.paid',
      payload: JSON.stringify({ payment_id: 'pay_1' }),
      url: 'https://example.com/webhook',
    })

    const mockFetchFail = async () => new Response('Server Error', { status: 500 })
    const processed = await processWebhookDeliveries(db, mockFetchFail as typeof fetch)
    expect(processed.attempted).toBe(1)
    expect(processed.failed).toBe(1)

    const delivery = await db.first<{ status: string; attempts: number }>(`SELECT status, attempts FROM webhook_deliveries LIMIT 1`)
    expect(delivery?.status).toBe('failed')
    expect(delivery?.attempts).toBe(1)
  })
})
```

- [ ] **Step 2: Create migration & implementation**

Create `migrations/0004_webhook_queue_and_multicurrency.sql`:
```sql
CREATE TABLE webhook_deliveries (
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

Create `src/core/webhook-queue.ts`:
```ts
import { hmacSha256Hex, newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

const BACKOFF_DELAYS_SECONDS = [60, 300, 900, 3600, 21600, 86400]

export async function enqueueWebhookDelivery(
  db: DatabaseAdapter,
  opts: {
    productId: string
    event: string
    payload: string
    url: string
    secret?: string | null
  },
): Promise<string> {
  const id = newId('whd')
  const nowIso = new Date().toISOString()
  await db.exec(
    `INSERT INTO webhook_deliveries (id, product_id, event, payload, url, status, attempts, next_retry_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [id, opts.productId, opts.event, opts.payload, opts.url, nowIso, nowIso],
  )
  return id
}

export async function processWebhookDeliveries(
  db: DatabaseAdapter,
  fetchFn = fetch,
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const nowIso = new Date().toISOString()
  const rows = await db.query<{
    id: string
    product_id: string
    event: string
    payload: string
    url: string
    attempts: number
  }>(
    `SELECT id, product_id, event, payload, url, attempts
     FROM webhook_deliveries
     WHERE status IN ('pending', 'failed') AND next_retry_at <= ? AND attempts < 6
     ORDER BY next_retry_at ASC LIMIT 50`,
    [nowIso],
  )

  let delivered = 0
  let failed = 0

  for (const row of rows) {
    const product = await db.first<{ webhook_secret: string | null }>(
      `SELECT webhook_secret FROM products WHERE id = ?`,
      [row.product_id],
    )

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-PayDeck-Event': row.event,
    }
    if (product?.webhook_secret) {
      headers['X-PayDeck-Signature'] = await hmacSha256Hex(product.webhook_secret, row.payload)
    }

    const attempt = row.attempts + 1
    const attemptIso = new Date().toISOString()

    try {
      const res = await fetchFn(row.url, {
        method: 'POST',
        headers,
        body: row.payload,
      })

      if (res.ok) {
        delivered++
        await db.exec(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?`,
          [attempt, attemptIso, row.id],
        )
      } else {
        failed++
        const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
        const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
        const errorMsg = `HTTP ${res.status}: ${res.statusText}`

        await db.exec(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
          [attempt, attemptIso, nextRetry, errorMsg, row.id],
        )
      }
    } catch (e) {
      failed++
      const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
      const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
      const errorMsg = (e as Error).message

      await db.exec(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
        [attempt, attemptIso, nextRetry, errorMsg, row.id],
      )
    }
  }

  return { attempted: rows.length, delivered, failed }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 2: Multi-Currency Validation & Customer Domain

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/routes/billing.ts`
- Test: `tests/multicurrency-customer.test.ts`

- [ ] **Step 1: Write test for Multi-Currency & Customers**

Create `tests/multicurrency-customer.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { CreateCustomerSchema, CreateOrderSchema } from '../src/schemas'

describe('Multi-Currency & Customer Schemas', () => {
  it('allows ISO-4217 currencies like USD, EUR, GBP', () => {
    const usd = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'USD' })
    expect(usd.success).toBe(true)

    const eur = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'EUR' })
    expect(eur.success).toBe(true)
  })

  it('validates CreateCustomerSchema', () => {
    const valid = CreateCustomerSchema.safeParse({ email: 'user@example.com', name: 'John Doe' })
    expect(valid.success).toBe(true)
  })
})
```

- [ ] **Step 2: Update `src/schemas.ts`**
  - Change `currency` validation to `z.string().trim().length(3).toUpperCase()`.
  - Add `CreateCustomerSchema`: `email` (optional email), `name` (optional string), `external_user_id` (optional string), `metadata` (optional record).

- [ ] **Step 3: Update `src/routes/billing.ts` to add Customer APIs**
  - `POST /v1/customers` (Create / Upsert customer)
  - `GET /v1/customers` (List customers)
  - `GET /v1/customers/:id/payments` (List payments for customer)

- [ ] **Step 4: Run `npm test` and `npm run typecheck`**

---

### Task 3: Webhook Delivery Admin APIs

**Files:**
- Modify: `src/routes/admin.ts`
- Test: `tests/webhook-admin.test.ts`

- [ ] **Step 1: Update `src/routes/admin.ts`**
  - `GET /v1/admin/webhooks`: List webhook deliveries with `limit`, `offset`, `status`, and `product_id` query filters.
  - `POST /v1/admin/webhooks/:id/redeliver`: Trigger immediate attempt for specific webhook delivery record.

- [ ] **Step 2: Create `tests/webhook-admin.test.ts` and run `npm test`**

---

### Task 4: SDK Auto-Retries & Signature Verifier

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client-resilience.test.ts`

- [ ] **Step 1: Write test for SDK Auto-Retries and Signature Verifier**

Create `tests/client-resilience.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'

describe('PayDeckClient Resilience & Webhook Signature', () => {
  it('verifies webhook signature statically', async () => {
    const payload = JSON.stringify({ event: 'payment.paid' })
    const secret = 'webhook_secret_123'
    // Compute signature and verify using PayDeckClient.verifyWebhookSignature
  })
})
```

- [ ] **Step 2: Update `src/client.ts`**
  - Add `retries` option (default 3) to `BillingClientOptions`.
  - Add retry wrapper around `fetchFn` for 429, 5xx, or network errors with exponential backoff (`100ms * 2^attempt`).
  - Add static method `PayDeckClient.verifyWebhookSignature(payload: string, signature: string, secret: string): Promise<boolean>`.

- [ ] **Step 3: Run `npm test` and `npm run typecheck`**

---

### Task 5: Final System Verification

- [ ] **Step 1: Execute `npm run build`**
- [ ] **Step 2: Execute `npm run typecheck`**
- [ ] **Step 3: Execute `npm test`**
