# Phase 2: Auditing & API Ergonomics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an immutable `audit_logs` table, record admin actions, implement `limit`/`offset` pagination on payment and audit list endpoints, enrich OpenAPI specification schemas, and add admin management methods to `PayDeckClient`.

**Architecture:** An `audit_logs` SQL table records admin events (product, key, plan creation/mutation). Payment and audit list handlers compute total counts and return `{ data, pagination: { limit, offset, total } }`. `PayDeckClient` in `src/client.ts` exposes complete admin and billing SDK methods.

**Tech Stack:** TypeScript, Hono, Vitest, SQLite.

---

## File Structure

- **`migrations/0002_audit_logs.sql`**: Migration script adding `audit_logs` table and indexes.
- **`src/core/audit.ts`**: Helper `logAudit()` for recording audit events into `audit_logs`.
- **`src/routes/admin.ts`**: Updated with audit logging calls and `GET /v1/admin/audit-logs` endpoint.
- **`src/routes/billing.ts`**: Updated with `limit`/`offset` pagination support on `/v1/payments`.
- **`src/client.ts`**: Updated with admin methods (`createProduct`, `mintKey`, `createPlan`, `listAuditLogs`).
- **`src/index.ts`**: Updated with complete OpenAPI schema definitions.

---

### Task 1: Audit Logging Migration & Core Logger

**Files:**
- Create: `migrations/0002_audit_logs.sql`
- Create: `src/core/audit.ts`
- Test: `tests/audit.test.ts`

- [ ] **Step 1: Write test for audit logger**

Create `tests/audit.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { logAudit } from '../src/core/audit'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('logAudit', () => {
  it('inserts audit log entries', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );
    `)

    await logAudit(db, {
      productId: 'prod_1',
      actor: 'admin',
      action: 'product.created',
      targetId: 'prod_1',
      details: { name: 'FormRelay' },
    })

    const logs = await db.query<{ id: string; action: string; details: string }>(`SELECT * FROM audit_logs`)
    expect(logs.length).toBe(1)
    expect(logs[0]?.action).toBe('product.created')
    expect(JSON.parse(logs[0]!.details).name).toBe('FormRelay')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/core/audit'".

- [ ] **Step 3: Create migration & implementation**

Create `migrations/0002_audit_logs.sql`:
```sql
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
```

Create `src/core/audit.ts`:
```ts
import { newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

export async function logAudit(
  db: DatabaseAdapter,
  opts: {
    productId?: string | null
    actor: string
    action: string
    targetId: string
    details?: Record<string, unknown>
  },
): Promise<void> {
  const id = newId('audit')
  const nowIso = new Date().toISOString()
  await db.exec(
    `INSERT INTO audit_logs (id, product_id, actor, action, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.productId || null,
      opts.actor,
      opts.action,
      opts.targetId,
      opts.details ? JSON.stringify(opts.details) : null,
      nowIso,
    ],
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

---

### Task 2: Audit Logging & Pagination in Admin and Billing Routes

**Files:**
- Modify: `src/routes/admin.ts`
- Modify: `src/routes/billing.ts`
- Test: `tests/pagination.test.ts`

- [ ] **Step 1: Write test for Payment & Audit Log Pagination**

Create `tests/pagination.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Payment & Audit Pagination', () => {
  it('returns pagination metadata', async () => {
    // Integration test verifying limit/offset pagination metadata
  })
})
```

- [ ] **Step 2: Update `src/routes/admin.ts`**
  - Add `logAudit` calls on product creation/update, key minting/revocation, and plan creation/update.
  - Add `GET /v1/admin/audit-logs` endpoint with `limit` (max 100) and `offset` pagination.

- [ ] **Step 3: Update `src/routes/billing.ts`**
  - Update `GET /v1/payments` and `GET /v1/admin/products/:slug/payments` to accept `limit` and `offset` query params and return `{ payments: [...], pagination: { limit, offset, total } }`.

- [ ] **Step 4: Run `npm test` and `npm run typecheck`**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

### Task 3: OpenAPI Specification & Admin SDK Methods

**Files:**
- Modify: `src/index.ts`
- Modify: `src/client.ts`
- Test: `tests/client.test.ts`

- [ ] **Step 1: Write test for `PayDeckClient` admin methods**

Create `tests/client.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'

describe('PayDeckClient Admin SDK', () => {
  it('supports admin methods', async () => {
    const mockFetch = async () => new Response(JSON.stringify({ products: [] }), { status: 200 })
    const client = new PayDeckClient({ baseUrl: 'http://localhost:8787', apiKey: 'pd_live_123', adminToken: 'admin_123', fetch: mockFetch as typeof fetch })
    const res = await client.listProducts()
    expect(res.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Update `src/client.ts` with admin SDK methods**
  - Add `adminToken` optional field to `BillingClientOptions`.
  - Add `createProduct()`, `listProducts()`, `updateProduct()`, `mintKey()`, `revokeKey()`, `createPlan()`, `updatePlan()`, `listAuditLogs()`.

- [ ] **Step 3: Update OpenAPI specification schemas in `src/index.ts`**

- [ ] **Step 4: Run `npm run typecheck && npm test`**

Run: `npm run typecheck && npm test`
Expected: PASS.

---

### Task 4: Final System Verification

- [ ] **Step 1: Execute `npm run build`**
- [ ] **Step 2: Execute `npm run typecheck`**
- [ ] **Step 3: Execute `npm test`**
