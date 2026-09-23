import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { billingRoutes } from '../src/routes/billing'
import { SQLiteAdapter } from '../src/db/sqlite'
import { sha256Hex } from '../src/crypto'
import { loadConfig } from '../src/config/env'
import type { AppVariables } from '../src/types'
import { getMonthBucket } from '../src/middleware/tier-limits'

async function setupTestDb(tier = 'free') {
  const db = new SQLiteAdapter(':memory:')
  await db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      org_id TEXT,
      rate_limit_per_hour INTEGER NOT NULL DEFAULT 200,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL DEFAULT 'live',
      active INTEGER NOT NULL DEFAULT 1,
      revoked_at TEXT,
      last_used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      api_key_id TEXT,
      plan_id TEXT,
      plan_slug TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      status TEXT NOT NULL,
      razorpay_order_id TEXT,
      receipt TEXT,
      notes TEXT,
      metadata TEXT,
      idempotency_key TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE rate_buckets (
      product_id TEXT NOT NULL,
      hour_bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, hour_bucket)
    );
    CREATE TABLE org_usage_meters (
      org_id TEXT NOT NULL,
      month_bucket TEXT NOT NULL,
      order_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, month_bucket)
    );
  `)

  await db.exec(
    `INSERT INTO organizations (id, slug, name, tier, owner_id, created_at) VALUES ('org_1', 'my-org', 'My Org', ?, 'usr_1', '2026-08-24T00:00:00Z')`,
    [tier],
  )
  await db.exec(
    `INSERT INTO products (id, slug, name, org_id, rate_limit_per_hour, active, created_at) VALUES ('prod_1', 'p1', 'Product 1', 'org_1', 1000, 1, '2026-08-24T00:00:00Z')`,
  )

  const token = 'pd_live_testkey123'
  const keyHash = await sha256Hex(token)
  const keyPrefix = token.slice(0, 14)
  await db.exec(
    `INSERT INTO api_keys (id, product_id, name, key_prefix, key_hash, created_at) VALUES ('key_1', 'prod_1', 'Test Key', ?, ?, '2026-08-24T00:00:00Z')`,
    [keyPrefix, keyHash],
  )

  const config = loadConfig({ ALLOW_DEV_CHARGE: '1' })
  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', async (c, next) => {
    c.set('config', config)
    c.set('db', db)
    await next()
  })
  app.route('/v1', billingRoutes)

  return { app, db, token }
}

describe('Usage Metering & Tier Limits', () => {
  it('allows orders up to free tier limit (100) and blocks 101st with 429', async () => {
    const { app, db, token } = await setupTestDb('free')
    const monthBucket = getMonthBucket()

    await db.exec(
      `INSERT INTO org_usage_meters (org_id, month_bucket, order_count) VALUES ('org_1', ?, 100)`,
      [monthBucket],
    )

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_paise: 500, currency: 'INR' }),
    })

    expect(res.status).toBe(429)
    const body: any = await res.json()
    expect(body.error).toBe('tier_limit_exceeded')
    expect(body.message).toContain('Monthly order volume tier limit reached')
  })

  it('increments usage meter on successful order creation', async () => {
    const { app, db, token } = await setupTestDb('free')
    const monthBucket = getMonthBucket()

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_paise: 500, currency: 'INR' }),
    })

    expect(res.status).toBe(201)
    const meter = await db.first<{ order_count: number }>(
      `SELECT order_count FROM org_usage_meters WHERE org_id = 'org_1' AND month_bucket = ?`,
      [monthBucket],
    )
    expect(meter?.order_count).toBe(1)
  })

  it('allows unlimited orders for business tier', async () => {
    const { app, db, token } = await setupTestDb('business')
    const monthBucket = getMonthBucket()

    await db.exec(
      `INSERT INTO org_usage_meters (org_id, month_bucket, order_count) VALUES ('org_1', ?, 1000)`,
      [monthBucket],
    )

    const res = await app.request('/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount_paise: 500, currency: 'INR' }),
    })

    expect(res.status).toBe(201)
  })
})
