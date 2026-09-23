# Generic Multi-Runtime PayDeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor PayDeck into a platform-agnostic, multi-runtime billing microservice supporting Node.js, Bun, Docker, and Cloudflare Workers with pluggable database adapters (SQLite, D1, Postgres) and dual `.env` / `paydeck.yaml` configuration.

**Architecture:** Core domain logic and Hono routes operate strictly on Web Standard APIs (`Request`, `Response`, `Web Crypto`). A `DatabaseAdapter` interface abstracts D1, SQLite (`better-sqlite3` / `bun:sqlite`), and PostgreSQL, while `src/config/` loads `.env` and `paydeck.yaml` settings into a unified runtime context.

**Tech Stack:** TypeScript, Hono, Vitest, Node.js (`@hono/node-server`), Bun, `better-sqlite3`, `js-yaml`, Docker.

---

## File Structure & Responsibilities

- **`src/db/adapter.ts`**: Defines `DatabaseAdapter` interface.
- **`src/db/sqlite.ts`**: Implements `DatabaseAdapter` for SQLite (file & in-memory via `better-sqlite3` / `bun:sqlite`).
- **`src/db/d1.ts`**: Implements `DatabaseAdapter` for Cloudflare D1 (`D1Database`).
- **`src/db/postgres.ts`**: Implements `DatabaseAdapter` for PostgreSQL.
- **`src/config/yaml.ts`**: Helper to load and parse `paydeck.yaml` / `config.yaml`.
- **`src/config/env.ts`**: Merges `.env`, `paydeck.yaml`, and runtime bindings (`c.env`) into a typed config object.
- **`src/entrypoints/node.ts`**: Standalone Node.js server entrypoint (`@hono/node-server`).
- **`src/entrypoints/bun.ts`**: Native Bun HTTP server entrypoint.
- **`src/entrypoints/cloudflare.ts`**: Cloudflare Workers fetch handler entrypoint.
- **`Dockerfile` & `docker-compose.yml`**: Deployment container configs.
- **`paydeck.example.yaml`**: Template configuration file.

---

### Task 1: Database Adapter Layer & Storage Abstraction

**Files:**
- Create: `src/db/adapter.ts`
- Create: `src/db/sqlite.ts`
- Create: `src/db/d1.ts`
- Create: `src/db/postgres.ts`
- Test: `tests/db-adapter.test.ts`

- [ ] **Step 1: Write tests for DatabaseAdapter implementations**

Create `tests/db-adapter.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('SQLiteAdapter (in-memory)', () => {
  it('executes schema and queries rows', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL
      );
    `)

    await db.exec(`INSERT INTO products (id, slug, name) VALUES (?, ?, ?)`, ['prod_1', 'formrelay', 'Formrelay'])

    const rows = await db.query<{ id: string; slug: string; name: string }>(
      `SELECT * FROM products WHERE slug = ?`,
      ['formrelay'],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.name).toBe('Formrelay')

    const single = await db.first<{ id: string; slug: string }>(
      `SELECT id, slug FROM products WHERE id = ?`,
      ['prod_1'],
    )
    expect(single?.slug).toBe('formrelay')
    await db.close?.()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/db/sqlite'".

- [ ] **Step 3: Define DatabaseAdapter interface and SQLiteAdapter implementation**

Create `src/db/adapter.ts`:
```ts
export interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  first<T>(sql: string, params?: unknown[]): Promise<T | null>
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>
  close?(): Promise<void>
}
```

Create `src/db/sqlite.ts`:
```ts
import Database from 'better-sqlite3'
import type { DatabaseAdapter } from './adapter'

export class SQLiteAdapter implements DatabaseAdapter {
  private db: InstanceType<typeof Database>

  constructor(filename = ':memory:') {
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as T[]
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql)
    const row = stmt.get(...params) as T | undefined
    return row ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const stmt = this.db.prepare(sql)
    const info = stmt.run(...params)
    return { changes: Number(info.changes) }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
```

Create `src/db/d1.ts`:
```ts
import type { DatabaseAdapter } from './adapter'

export class D1Adapter implements DatabaseAdapter {
  constructor(private d1: D1Database) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { results } = await this.d1.prepare(sql).bind(...params).all<T>()
    return results || []
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.d1.prepare(sql).bind(...params).first<T>()
    return res ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.d1.prepare(sql).bind(...params).run()
    return { changes: res.meta?.changes ?? 0 }
  }
}
```

Create `src/db/postgres.ts`:
```ts
import type { DatabaseAdapter } from './adapter'

export class PostgresAdapter implements DatabaseAdapter {
  constructor(private client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params)
    return (res.rows as T[]) || []
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.client.query(sql, params)
    return { changes: res.rowCount || 0 }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (16 passed).

- [ ] **Step 5: Commit**

```bash
git add src/db/ tests/db-adapter.test.ts
git commit -m "feat: add DatabaseAdapter interface with SQLite, D1, and Postgres implementations"
```

---

### Task 2: Configuration Loader Layer (`.env` & `paydeck.yaml`)

**Files:**
- Create: `src/config/yaml.ts`
- Create: `src/config/env.ts`
- Create: `paydeck.example.yaml`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write test for configuration loading**

Create `tests/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/env'

describe('loadConfig', () => {
  it('loads default values when process.env and yaml are empty', () => {
    const cfg = loadConfig({})
    expect(cfg.port).toBe(8787)
    expect(cfg.dbType).toBe('sqlite')
    expect(cfg.allowDevCharge).toBe(false)
  })

  it('allows process.env overrides', () => {
    const cfg = loadConfig({
      PORT: '9000',
      DB_TYPE: 'postgres',
      ALLOW_DEV_CHARGE: '1',
      BILLING_ADMIN_TOKEN: 'secret-admin-token',
    })
    expect(cfg.port).toBe(9000)
    expect(cfg.dbType).toBe('postgres')
    expect(cfg.allowDevCharge).toBe(true)
    expect(cfg.adminToken).toBe('secret-admin-token')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/config/env'".

- [ ] **Step 3: Implement YAML loader & Configuration manager**

Create `paydeck.example.yaml`:
```yaml
server:
  port: 8787
  host: "0.0.0.0"

database:
  type: "sqlite"               # options: sqlite | d1 | postgres
  sqlite:
    path: "./data/paydeck.db"
  postgres:
    url: "postgres://user:pass@localhost:5432/paydeck"

razorpay:
  key_id: ""
  key_secret: ""
  webhook_secret: ""

admin:
  token: "change-me-admin-token"

policy:
  default_rate_limit_per_hour: 200
  allow_dev_charge: false
```

Create `src/config/env.ts`:
```ts
export type PayDeckConfig = {
  port: number
  dbType: 'sqlite' | 'd1' | 'postgres'
  dbPath: string
  dbUrl: string
  adminToken: string
  razorpayKeyId: string
  razorpayKeySecret: string
  razorpayWebhookSecret: string
  allowDevCharge: boolean
  rateLimitPerHour: number
}

export function loadConfig(env: Record<string, string | undefined> = process.env): PayDeckConfig {
  const port = Number(env.PORT || '8787')
  const dbType = (env.DB_TYPE || 'sqlite').toLowerCase() as 'sqlite' | 'd1' | 'postgres'
  const dbPath = env.DATABASE_PATH || './data/paydeck.db'
  const dbUrl = env.DATABASE_URL || ''
  const adminToken = env.BILLING_ADMIN_TOKEN || ''
  const razorpayKeyId = env.RAZORPAY_KEY_ID || ''
  const razorpayKeySecret = env.RAZORPAY_KEY_SECRET || ''
  const razorpayWebhookSecret = env.RAZORPAY_WEBHOOK_SECRET || ''
  const allowDevCharge = env.ALLOW_DEV_CHARGE === '1' || env.ALLOW_DEV_CHARGE === 'true'
  const rateLimitPerHour = Number(env.RATE_LIMIT_PER_HOUR || '200')

  return {
    port,
    dbType,
    dbPath,
    dbUrl,
    adminToken,
    razorpayKeyId,
    razorpayKeySecret,
    razorpayWebhookSecret,
    allowDevCharge,
    rateLimitPerHour,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS (18 passed).

- [ ] **Step 5: Commit**

```bash
git add src/config/ paydeck.example.yaml tests/config.test.ts
git commit -m "feat: implement loadConfig with environment variable and defaults support"
```

---

### Task 3: Refactor Core Domain & Routes to use `DatabaseAdapter`

**Files:**
- Modify: `src/auth.ts`
- Modify: `src/policy.ts`
- Modify: `src/routes/billing.ts`
- Modify: `src/routes/admin.ts`
- Modify: `src/routes/webhooks.ts`
- Modify: `src/types.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Update `src/types.ts` to use `DatabaseAdapter` & `PayDeckConfig`**

Update `src/types.ts`:
```ts
import type { DatabaseAdapter } from './db/adapter'
import type { PayDeckConfig } from './config/env'

export type AppVariables = {
  db: DatabaseAdapter
  config: PayDeckConfig
  auth?: AuthContext
}

export type ProductRow = {
  id: string
  slug: string
  name: string
  rate_limit_per_hour: number
  active: number
  created_at: string
}

export type ApiKeyRow = {
  id: string
  product_id: string
  name: string
  key_prefix: string
  key_hash: string
  environment: string
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

export type PlanRow = {
  id: string
  product_id: string
  slug: string
  name: string
  amount_paise: number
  currency: string
  interval: string
  active: number
  created_at: string
}

export type PaymentRow = {
  id: string
  product_id: string
  api_key_id: string | null
  plan_id: string | null
  plan_slug: string | null
  amount_paise: number
  currency: string
  status: string
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  receipt: string | null
  notes: string | null
  metadata: string | null
  idempotency_key: string | null
  confirmed_at: string | null
  created_at: string
}

export type AuthContext = {
  product: ProductRow
  key: ApiKeyRow
}

export type CreateOrderRequest = {
  plan?: string
  amount_paise?: number
  currency?: string
  receipt?: string
  notes?: Record<string, string>
  metadata?: Record<string, unknown>
  description?: string
}

export type VerifyRequest = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}
```

- [ ] **Step 2: Update `src/auth.ts`, `src/policy.ts`, and routes to use `c.get('db')` and `c.get('config')`**

Update `src/auth.ts`:
```ts
import type { Context, Next } from 'hono'
import { parseBearer, sha256Hex, timingSafeEqual } from './crypto'
import type { ApiKeyRow, AppVariables, ProductRow } from './types'

export async function requireProductKey(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = parseBearer(c.req.header('Authorization'))
  if (!token || (!token.startsWith('pd_') && !token.startsWith('db_') && !token.startsWith('pb_'))) {
    return c.json({ error: 'missing_or_invalid_api_key' }, 401)
  }

  const hash = await sha256Hex(token)
  const prefix = token.slice(0, 14)
  const db = c.get('db')

  const key = await db.first<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE key_prefix = ? AND key_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [prefix, hash],
  )

  if (!key) {
    return c.json({ error: 'invalid_api_key' }, 401)
  }

  const product = await db.first<ProductRow>(
    `SELECT * FROM products WHERE id = ? AND active = 1 LIMIT 1`,
    [key.product_id],
  )

  if (!product) {
    return c.json({ error: 'product_inactive' }, 403)
  }

  const nowIso = new Date().toISOString()
  c.executionCtx?.waitUntil?.(
    db.exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [nowIso, key.id]),
  )

  c.set('auth', { product, key })
  await next()
}

export async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const config = c.get('config')
  const expected = config.adminToken
  if (!expected) {
    return c.json({ error: 'admin_not_configured' }, 503)
  }
  const provided =
    c.req.header('X-Admin-Token') ||
    parseBearer(c.req.header('Authorization')) ||
    ''
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}
```

Update `src/policy.ts`:
```ts
import type { DatabaseAdapter } from './db/adapter'
import type { ProductRow } from './types'

export function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
}

export async function assertWithinRateLimit(
  db: DatabaseAdapter,
  product: ProductRow,
): Promise<{ ok: true } | { ok: false; limit: number; used: number }> {
  const bucket = hourBucket()
  const row = await db.first<{ count: number }>(
    `SELECT count FROM rate_buckets WHERE product_id = ? AND hour_bucket = ?`,
    [product.id, bucket],
  )

  const used = row?.count ?? 0
  if (used >= product.rate_limit_per_hour) {
    return { ok: false, limit: product.rate_limit_per_hour, used }
  }

  await db.exec(
    `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES (?, ?, 1)
     ON CONFLICT(product_id, hour_bucket) DO UPDATE SET count = count + 1`,
    [product.id, bucket],
  )

  return { ok: true }
}

export function isValidPlanInterval(interval: string): boolean {
  return interval === 'month' || interval === 'year' || interval === 'one_time'
}
```

- [ ] **Step 3: Run static typecheck**

Run: `npm run typecheck`
Expected: PASS with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "refactor: update auth, policy, and types to use DatabaseAdapter and PayDeckConfig"
```

---

### Task 4: Multi-Target Server Entrypoints (Node.js, Bun, Cloudflare)

**Files:**
- Create: `src/entrypoints/node.ts`
- Create: `src/entrypoints/bun.ts`
- Create: `src/entrypoints/cloudflare.ts`
- Modify: `package.json`

- [ ] **Step 1: Create Node.js entrypoint (`src/entrypoints/node.ts`)**

Create `src/entrypoints/node.ts`:
```ts
import { serve } from '@hono/node-server'
import { loadConfig } from '../config/env'
import { SQLiteAdapter } from '../db/sqlite'
import app from '../index'

const config = loadConfig(process.env)
const db = new SQLiteAdapter(config.dbPath)

// Inject middleware for standalone Node server
app.use('*', async (c, next) => {
  c.set('config', config)
  c.set('db', db)
  await next()
})

console.log(`🚀 PayDeck starting on http://0.0.0.0:${config.port}`)
serve({
  fetch: app.fetch,
  port: config.port,
})
```

- [ ] **Step 2: Create Bun entrypoint (`src/entrypoints/bun.ts`)**

Create `src/entrypoints/bun.ts`:
```ts
import { loadConfig } from '../config/env'
import { SQLiteAdapter } from '../db/sqlite'
import app from '../index'

const config = loadConfig(process.env)
const db = new SQLiteAdapter(config.dbPath)

app.use('*', async (c, next) => {
  c.set('config', config)
  c.set('db', db)
  await next()
})

export default {
  port: config.port,
  fetch: app.fetch,
}
```

- [ ] **Step 3: Create Cloudflare Workers entrypoint (`src/entrypoints/cloudflare.ts`)**

Create `src/entrypoints/cloudflare.ts`:
```ts
import { loadConfig } from '../config/env'
import { D1Adapter } from '../db/d1'
import app from '../index'

export default {
  async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env as Record<string, string>)
    const d1 = env.DB as D1Database
    const db = new D1Adapter(d1)

    app.use('*', async (c, next) => {
      c.set('config', config)
      c.set('db', db)
      await next()
    })

    return app.fetch(req, env, ctx)
  },
}
```

- [ ] **Step 4: Update `package.json` scripts**

Update `package.json`:
```json
  "scripts": {
    "start": "node dist/entrypoints/node.js",
    "start:bun": "bun run src/entrypoints/bun.ts",
    "dev": "wrangler dev src/entrypoints/cloudflare.ts",
    "deploy": "wrangler deploy src/entrypoints/cloudflare.ts",
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
```

- [ ] **Step 5: Run typecheck and test**

Run: `npm run typecheck && npm test`
Expected: PASS with 0 errors.

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints/ package.json
git commit -m "feat: add Node.js, Bun, and Cloudflare Workers target entrypoints"
```

---

### Task 5: Containerization (Dockerfile & Docker Compose)

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

- [ ] **Step 1: Create multi-stage `Dockerfile`**

Create `Dockerfile`:
```dockerfile
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DATABASE_PATH=/app/data/paydeck.db

COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/migrations ./migrations

RUN mkdir -p /app/data

EXPOSE 8787
CMD ["npm", "start"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

Create `docker-compose.yml`:
```yaml
version: '3.8'

services:
  paydeck:
    build: .
    ports:
      - "8787:8787"
    environment:
      - PORT=8787
      - DB_TYPE=sqlite
      - DATABASE_PATH=/app/data/paydeck.db
      - BILLING_ADMIN_TOKEN=change-me-admin-token
      - ALLOW_DEV_CHARGE=1
    volumes:
      - paydeck_data:/app/data

volumes:
  paydeck_data:
```

- [ ] **Step 3: Commit Container configs**

```bash
git add Dockerfile docker-compose.yml
git commit -m "ci: add Dockerfile and docker-compose.yml for standalone container deployments"
```

---

### Task 6: Final Verification & Test Suite Run

- [ ] **Step 1: Execute type check**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 2: Execute full Vitest test suite**

Run: `npm test`
Expected: PASS (all tests passing).

- [ ] **Step 3: Commit final plan verification state**

```bash
git commit --allow-empty -m "chore: verified generic multi-runtime PayDeck refactor"
```
