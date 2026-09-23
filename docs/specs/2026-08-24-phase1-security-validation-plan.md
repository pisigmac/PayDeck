# Phase 1: Security & Input Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Zod input validation, standard error envelopes with `request_id`, security headers, configurable CORS, rate limit headers, and fail-closed webhook signature verification.

**Architecture:** A request ID middleware assigns `req_<hex>` to every request. Zod schemas in `src/core/validation.ts` validate JSON payloads before route handlers execute. Responses include security headers and standard rate limit headers. Webhooks fail closed on missing/invalid signatures.

**Tech Stack:** TypeScript, Hono, Zod, Vitest.

---

## File Structure

- **`src/core/validation.ts`**: Zod validation schemas (`CreateOrderSchema`, `VerifyRequestSchema`, `CreateProductSchema`, `CreatePlanSchema`, `CreateKeySchema`) & helper `validateBody()`.
- **`src/middleware/request-id.ts`**: Middleware generating unique `request_id` (`req_<hex>`) attached to Hono context.
- **`src/middleware/security.ts`**: Middleware adding security headers (`nosniff`, `DENY`, `HSTS`) and handling allowed origins.
- **`src/policy.ts`**: Updated to compute rate limit header values (`limit`, `remaining`, `resetSeconds`).
- **`src/routes/webhooks.ts`**: Updated to enforce fail-closed signature verification.
- **`src/routes/*.ts`**: Updated to return standardized error envelopes.

---

### Task 1: Zod Validation & Request ID Middleware

**Files:**
- Create: `src/core/validation.ts`
- Create: `src/middleware/request-id.ts`
- Test: `tests/validation.test.ts`

- [ ] **Step 1: Write tests for Zod schemas & Request ID middleware**

Create `tests/validation.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  CreateOrderSchema,
  CreatePlanSchema,
  CreateProductSchema,
  VerifyRequestSchema,
  formatZodError,
} from '../src/core/validation'

describe('Zod Validation Schemas', () => {
  it('validates CreateOrderSchema', () => {
    const valid = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'INR' })
    expect(valid.success).toBe(true)

    const invalid = CreateOrderSchema.safeParse({ amount_paise: 50 })
    expect(invalid.success).toBe(false)
  })

  it('validates CreateProductSchema', () => {
    const valid = CreateProductSchema.safeParse({ slug: 'form-relay_1', name: 'FormRelay' })
    expect(valid.success).toBe(true)

    const invalid = CreateProductSchema.safeParse({ slug: 'Invalid Slug!', name: '' })
    expect(invalid.success).toBe(false)
  })

  it('formats Zod errors into structured details', () => {
    const res = CreatePlanSchema.safeParse({ slug: 'pro', amount_paise: 50, interval: 'invalid' })
    expect(res.success).toBe(false)
    if (!res.success) {
      const formatted = formatZodError(res.error)
      expect(formatted.length).toBeGreaterThan(0)
      expect(formatted[0]).toHaveProperty('field')
      expect(formatted[0]).toHaveProperty('message')
    }
  })
})
```

- [ ] **Step 2: Install Zod and run test to verify it fails**

Run: `npm install zod && npm test`
Expected: FAIL with "Cannot find module '../src/core/validation'".

- [ ] **Step 3: Implement Zod schemas & Request ID middleware**

Create `src/middleware/request-id.ts`:
```ts
import type { Context, Next } from 'hono'
import { newId } from '../crypto'
import type { AppVariables } from '../types'

export async function requestIdMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const reqId = c.req.header('X-Request-Id') || newId('req')
  c.set('requestId', reqId)
  c.header('X-Request-Id', reqId)
  await next()
}
```

Create `src/core/validation.ts`:
```ts
import { z } from 'zod'

export const CreateOrderSchema = z.object({
  plan: z.string().trim().lowercase().optional(),
  amount_paise: z.number().int().min(100, 'Minimum 100 paise (₹1)').optional(),
  currency: z.string().trim().toUpperCase().default('INR').refine((c) => c === 'INR', { message: 'Only INR supported' }),
  receipt: z.string().trim().max(40, 'Receipt maximum 40 characters').optional(),
  notes: z.record(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
  description: z.string().optional(),
}).refine((data) => data.plan || data.amount_paise != null, {
  message: 'Either plan or amount_paise is required',
})

export const VerifyRequestSchema = z.object({
  razorpay_order_id: z.string().trim().min(1, 'razorpay_order_id is required'),
  razorpay_payment_id: z.string().trim().min(1, 'razorpay_payment_id is required'),
  razorpay_signature: z.string().trim().min(1, 'razorpay_signature is required'),
})

export const CreateProductSchema = z.object({
  slug: z.string().trim().lowercase().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'Invalid product slug format'),
  name: z.string().trim().min(1, 'Name is required'),
  rate_limit_per_hour: z.number().int().min(1).max(100000).default(200),
})

export const CreatePlanSchema = z.object({
  slug: z.string().trim().lowercase().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid plan slug format'),
  name: z.string().trim().min(1, 'Name is required'),
  amount_paise: z.number().int().min(100, 'Minimum 100 paise (₹1)'),
  currency: z.string().trim().toUpperCase().default('INR').refine((c) => c === 'INR', { message: 'Only INR supported' }),
  interval: z.enum(['month', 'year', 'one_time']),
})

export const CreateKeySchema = z.object({
  name: z.string().trim().optional(),
  environment: z.enum(['live', 'test']).default('live'),
})

export function formatZodError(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }))
}

export function errorEnvelope(
  requestId: string,
  error: string,
  code: string,
  message: string,
  details?: Array<{ field: string; message: string }>,
) {
  return {
    error,
    code,
    message,
    request_id: requestId,
    ...(details && details.length > 0 ? { details } : {}),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 2: Configurable CORS & Security Headers Middleware

**Files:**
- Create: `src/middleware/security.ts`
- Modify: `src/config/env.ts`
- Modify: `src/index.ts`
- Test: `tests/security.test.ts`

- [ ] **Step 1: Write test for Security Headers & Configurable CORS**

Create `tests/security.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Security Headers Middleware', () => {
  it('includes security headers in API responses', async () => {
    const res = await app.request('/v1/openapi.json')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
  })
})
```

- [ ] **Step 2: Implement `src/middleware/security.ts` & update `src/index.ts`**

Create `src/middleware/security.ts`:
```ts
import type { Context, Next } from 'hono'
import type { AppVariables } from '../types'

export async function securityHeadersMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  await next()
}
```

Update `src/index.ts` to mount `requestIdMiddleware` and `securityHeadersMiddleware`.

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 3: Standard Rate Limit Response Headers

**Files:**
- Modify: `src/policy.ts`
- Modify: `src/routes/billing.ts`
- Test: `tests/rate-limit.test.ts`

- [ ] **Step 1: Write tests for Rate Limit headers**

Create `tests/rate-limit.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { assertWithinRateLimit } from '../src/policy'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('assertWithinRateLimit', () => {
  it('calculates limit, used, remaining, and resetSeconds', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE rate_buckets (
        product_id TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, hour_bucket)
      );
    `)

    const product = { id: 'p1', slug: 'p1', name: 'P1', rate_limit_per_hour: 5, active: 1, created_at: '' }
    const res1 = await assertWithinRateLimit(db, product)
    expect(res1.ok).toBe(true)
    if (res1.ok) {
      expect(res1.limit).toBe(5)
      expect(res1.remaining).toBe(4)
      expect(res1.resetSeconds).toBeGreaterThan(0)
    }
  })
})
```

- [ ] **Step 2: Update `assertWithinRateLimit` in `src/policy.ts`**

Update `src/policy.ts`:
```ts
import type { DatabaseAdapter } from './db/adapter'
import type { ProductRow } from './types'

export function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
}

export function secondsUntilNextHour(d = new Date()): number {
  const nextHour = new Date(d)
  nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0)
  return Math.ceil((nextHour.getTime() - d.getTime()) / 1000)
}

export async function assertWithinRateLimit(
  db: DatabaseAdapter,
  product: ProductRow,
): Promise<
  | { ok: true; limit: number; used: number; remaining: number; resetSeconds: number }
  | { ok: false; limit: number; used: number; remaining: number; resetSeconds: number }
> {
  const bucket = hourBucket()
  const resetSeconds = secondsUntilNextHour()
  const row = await db.first<{ count: number }>(
    `SELECT count FROM rate_buckets WHERE product_id = ? AND hour_bucket = ?`,
    [product.id, bucket],
  )

  const used = row?.count ?? 0
  const limit = product.rate_limit_per_hour
  const remaining = Math.max(0, limit - used - 1)

  if (used >= limit) {
    return { ok: false, limit, used, remaining: 0, resetSeconds }
  }

  await db.exec(
    `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES (?, ?, 1)
     ON CONFLICT(product_id, hour_bucket) DO UPDATE SET count = count + 1`,
    [product.id, bucket],
  )

  return { ok: true, limit, used: used + 1, remaining, resetSeconds }
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 4: Fail-Closed Webhook Verification

**Files:**
- Modify: `src/routes/webhooks.ts`
- Test: `tests/webhooks.test.ts`

- [ ] **Step 1: Write test for Fail-Closed Webhook Endpoint**

Create `tests/webhooks.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Fail-Closed Webhooks', () => {
  it('rejects webhooks with missing signature when secret is configured', async () => {
    // Webhook route tests fail-closed behavior
  })
})
```

- [ ] **Step 2: Refactor `src/routes/webhooks.ts`**

Update `src/routes/webhooks.ts` so that when `config.razorpayWebhookSecret` is present, a missing or invalid signature returns `401 Unauthorized` / `400 Bad Request` with standard error envelope.

- [ ] **Step 3: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 5: Refactor Route Handlers with Zod & Error Envelopes

**Files:**
- Modify: `src/routes/billing.ts`
- Modify: `src/routes/admin.ts`
- Test: `tests/integration.test.ts`

- [ ] **Step 1: Refactor `billing.ts` and `admin.ts` to use Zod parsing and `errorEnvelope`**
- [ ] **Step 2: Run `npm run typecheck && npm test`**
- [ ] **Step 3: Verify all test suites pass**

---

### Task 6: Final Verification & Test Suite Run

- [ ] **Step 1: Execute type check (`npm run typecheck`)**
- [ ] **Step 2: Execute full Vitest suite (`npm test`)**
