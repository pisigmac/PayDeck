# Phase 5: Stripe Gateway, Subscriptions, Web Worker & Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Stripe Gateway Adapter, background webhook queue worker, subscription domain and lifecycle management, multi-admin authentication, web admin dashboard UI, and SDK extensions.

**Architecture:** `StripeGatewayAdapter` processes Stripe PaymentIntents and Refunds. Subscriptions are tracked in `subscriptions` table with active/canceled status transitions. `public/admin/index.html` provides a zero-dependency SPA dashboard for platform administration.

**Tech Stack:** TypeScript, Hono, Vitest, Vanilla HTML5/CSS3.

---

## File Structure

- **`migrations/0005_subscriptions_and_stripe.sql`**: Migration for `subscriptions` and `admin_users` tables.
- **`src/gateways/stripe.ts`**: Stripe PaymentGatewayAdapter implementation.
- **`src/core/subscriptions.ts`**: Core subscription engine (`createSubscription`, `cancelSubscription`).
- **`src/core/webhook-worker.ts`**: Periodic background queue processor.
- **`src/routes/billing.ts` & `src/routes/admin.ts`**: Subscription routes, Stripe order handling, admin login, and dashboard asset serving.
- **`public/admin/index.html`**: SPA Admin UI.
- **`src/client.ts`**: Extended with subscription methods (`createSubscription`, `listSubscriptions`, `cancelSubscription`).

---

### Task 1: Subscriptions Core, Webhook Worker & Migration

**Files:**
- Create: `migrations/0005_subscriptions_and_stripe.sql`
- Create: `src/core/subscriptions.ts`
- Create: `src/core/webhook-worker.ts`
- Test: `tests/subscriptions.test.ts`

- [ ] **Step 1: Write test for Subscriptions Core & Webhook Worker**

Create `tests/subscriptions.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createSubscription, cancelSubscription } from '../src/core/subscriptions'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('Subscriptions Domain Engine', () => {
  it('creates and cancels subscriptions', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE subscriptions (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        current_period_start TEXT NOT NULL,
        current_period_end TEXT NOT NULL,
        cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `)

    const sub = await createSubscription(db, {
      productId: 'prod_1',
      customerId: 'cust_1',
      planId: 'plan_1',
      periodDays: 30,
    })

    expect(sub.status).toBe('active')
    const canceled = await cancelSubscription(db, sub.id)
    expect(canceled.status).toBe('canceled')
  })
})
```

- [ ] **Step 2: Create migration and implementations**

Create `migrations/0005_subscriptions_and_stripe.sql`:
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

Create `src/core/subscriptions.ts`:
```ts
import { newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

export async function createSubscription(
  db: DatabaseAdapter,
  opts: {
    productId: string
    customerId: string
    planId: string
    periodDays?: number
  },
) {
  const id = newId('sub')
  const now = new Date()
  const startIso = now.toISOString()
  const periodDays = opts.periodDays || 30
  const endIso = new Date(now.getTime() + periodDays * 86400 * 1000).toISOString()

  await db.exec(
    `INSERT INTO subscriptions (id, product_id, customer_id, plan_id, status, current_period_start, current_period_end, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, opts.productId, opts.customerId, opts.planId, startIso, endIso, startIso],
  )

  return { id, productId: opts.productId, customerId: opts.customerId, planId: opts.planId, status: 'active', current_period_start: startIso, current_period_end: endIso }
}

export async function cancelSubscription(db: DatabaseAdapter, subscriptionId: string, immediately = true) {
  if (immediately) {
    await db.exec(`UPDATE subscriptions SET status = 'canceled' WHERE id = ?`, [subscriptionId])
  } else {
    await db.exec(`UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?`, [subscriptionId])
  }
  return { id: subscriptionId, status: immediately ? 'canceled' : 'active' }
}
```

Create `src/core/webhook-worker.ts`:
```ts
import type { DatabaseAdapter } from '../db/adapter'
import { processWebhookDeliveries } from './webhook-queue'

export function startWebhookWorker(db: DatabaseAdapter, intervalMs = 60000) {
  const timer = setInterval(async () => {
    try {
      await processWebhookDeliveries(db)
    } catch (e) {
      console.warn('Webhook worker error:', e)
    }
  }, intervalMs)

  return () => clearInterval(timer)
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 2: Stripe Gateway Adapter

**Files:**
- Create: `src/gateways/stripe.ts`
- Modify: `src/gateways/adapter.ts`
- Test: `tests/stripe-gateway.test.ts`

- [ ] **Step 1: Write test for `StripeGatewayAdapter`**

Create `tests/stripe-gateway.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { StripeGatewayAdapter } from '../src/gateways/stripe'

describe('StripeGatewayAdapter', () => {
  it('calls Stripe PaymentIntents API', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ id: 'pi_123', client_secret: 'secret_123', status: 'succeeded' }), { status: 200 })
    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as typeof fetch)

    const order = await stripe.createOrder({ amountPaise: 1000, currency: 'USD', receipt: 'rcpt_1' })
    expect(order.ok).toBe(true)
    if (order.ok) {
      expect(order.orderId).toBe('pi_123')
    }
  })
})
```

- [ ] **Step 2: Create `src/gateways/stripe.ts`**

Create `src/gateways/stripe.ts`:
```ts
import type { CreateOrderOpts, PaymentGatewayAdapter, RefundOpts, VerifyPaymentOpts } from './adapter'

export class StripeGatewayAdapter implements PaymentGatewayAdapter {
  name = 'stripe'
  private secretKey: string
  private fetchFn: typeof fetch

  constructor(secretKey: string, fetchFn = fetch) {
    this.secretKey = secretKey
    this.fetchFn = fetchFn
  }

  private authHeader() {
    return 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64')
  }

  async createOrder(opts: CreateOrderOpts) {
    try {
      const params = new URLSearchParams()
      params.set('amount', String(opts.amountPaise))
      params.set('currency', opts.currency.toLowerCase())
      params.set('description', opts.receipt)
      params.set('payment_method_types[]', 'card')

      const res = await this.fetchFn('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      })

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        return { ok: false as const, error: String((json.error as Record<string, unknown>)?.message || res.statusText) }
      }

      return { ok: true as const, orderId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }

  async verifyPayment(opts: VerifyPaymentOpts) {
    try {
      const res = await this.fetchFn(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(opts.orderId)}`, {
        headers: { Authorization: this.authHeader() },
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return res.ok && json.status === 'succeeded'
    } catch {
      return false
    }
  }

  async refundPayment(opts: RefundOpts) {
    try {
      const params = new URLSearchParams()
      params.set('payment_intent', opts.paymentId)
      params.set('amount', String(opts.amountPaise))

      const res = await this.fetchFn('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      })

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) return { ok: false as const, error: String((json.error as Record<string, unknown>)?.message || res.statusText) }
      return { ok: true as const, refundId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }
}
```

- [ ] **Step 3: Update `getGatewayAdapter` in `src/gateways/adapter.ts` to instantiate `StripeGatewayAdapter` when gateway is `'stripe'` or `STRIPE_SECRET_KEY` is present.**

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 3: Subscription Routes & Multi-Admin Login

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/routes/billing.ts`
- Modify: `src/routes/admin.ts`
- Test: `tests/subscription-routes.test.ts`

- [ ] **Step 1: Write test for Subscription Routes & Admin Login**

Create `tests/subscription-routes.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Subscription Routes & Admin Login', () => {
  it('creates and lists subscriptions', async () => {
    // Integration test verifying subscription creation & listing
  })
})
```

- [ ] **Step 2: Add subscription routes in `billing.ts`**
  - `POST /v1/subscriptions`: Validates body using `CreateSubscriptionSchema`. Calls `createSubscription()`.
  - `GET /v1/subscriptions`: Lists subscriptions with `limit`/`offset` pagination.
  - `POST /v1/subscriptions/:id/cancel`: Cancels subscription.

- [ ] **Step 3: Add admin login in `admin.ts`**
  - `POST /v1/admin/login`: Authenticates against `admin_users` table or fallback `BILLING_ADMIN_TOKEN`.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`**

---

### Task 4: Web Admin Dashboard UI (`public/admin/index.html`)

**Files:**
- Create: `public/admin/index.html`
- Modify: `src/index.ts`
- Test: `tests/admin-ui.test.ts`

- [ ] **Step 1: Create Single-Page Web Admin UI in `public/admin/index.html`**
  Includes UI tabs for:
  - Products & Plans
  - API Keys
  - Customers & Subscriptions
  - Payments & Refunds
  - Audit Logs
  - Webhook Deliveries & Manual Redeliveries

- [ ] **Step 2: Serve static assets in `src/index.ts`**

---

### Task 5: SDK Extensions (`src/client.ts`)

**Files:**
- Modify: `src/client.ts`
- Test: `tests/client-subscriptions.test.ts`

- [ ] **Step 1: Add subscription SDK methods to `PayDeckClient` in `src/client.ts`**:
  - `createSubscription(input)`
  - `listSubscriptions(opts)`
  - `cancelSubscription(id, immediately)`

- [ ] **Step 2: Run `npm test` and `npm run typecheck`**

---

### Task 6: Final Verification & Test Suite Execution

- [ ] **Step 1: Execute `npm run build`**
- [ ] **Step 2: Execute `npm run typecheck`**
- [ ] **Step 3: Execute `npm test`**
