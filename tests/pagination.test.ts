import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { adminRoutes } from '../src/routes/admin'
import { billingRoutes } from '../src/routes/billing'
import { SQLiteAdapter } from '../src/db/sqlite'
import { loadConfig } from '../src/config/env'
import { mintApiKey } from '../src/crypto'
import type { AppVariables } from '../src/types'

async function setupTestDb() {
  const db = new SQLiteAdapter(':memory:')
  await db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      rate_limit_per_hour INTEGER NOT NULL DEFAULT 200,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL DEFAULT 'live',
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      interval TEXT NOT NULL DEFAULT 'month',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE (product_id, slug)
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
      razorpay_payment_id TEXT,
      receipt TEXT,
      notes TEXT,
      metadata TEXT,
      idempotency_key TEXT,
      confirmed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE rate_buckets (
      product_id TEXT NOT NULL,
      hour_bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, hour_bucket)
    );
  `)
  return db
}

function createTestApp(db: SQLiteAdapter, envOverrides: Record<string, string> = {}) {
  const config = loadConfig({
    BILLING_ADMIN_TOKEN: 'secret-admin-token',
    ...envOverrides,
  })

  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', async (c, next) => {
    c.set('config', config)
    c.set('db', db)
    await next()
  })

  app.route('/v1/admin', adminRoutes)
  app.route('/v1', billingRoutes)

  return app
}

describe('Audit Logging & Pagination Integration', () => {
  it('records audit logs on admin actions and retrieves them via GET /v1/admin/audit-logs', async () => {
    const db = await setupTestDb()
    const app = createTestApp(db)

    const request = (path: string, options: RequestInit = {}) => {
      return app.request(`http://localhost${path}`, options)
    }

    const adminHeaders = {
      'X-Admin-Token': 'secret-admin-token',
      'Content-Type': 'application/json',
    }

    // 1. Create Product -> audit: product.created
    const createProdRes = await request('/v1/admin/products', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ slug: 'testprod', name: 'Test Product' }),
    })
    expect(createProdRes.status).toBe(201)
    const prod = (await createProdRes.json()) as any

    // 2. Update Product -> audit: product.updated
    const updateProdRes = await request('/v1/admin/products/testprod', {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Updated Product Name' }),
    })
    expect(updateProdRes.status).toBe(200)

    // 3. Mint Key -> audit: key.minted
    const mintKeyRes = await request('/v1/admin/products/testprod/keys', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'test key', environment: 'live' }),
    })
    expect(mintKeyRes.status).toBe(201)
    const keyData = (await mintKeyRes.json()) as any

    // 4. Revoke Key -> audit: key.revoked
    const revokeKeyRes = await request(
      `/v1/admin/products/testprod/keys/${keyData.id}/revoke`,
      {
        method: 'POST',
        headers: adminHeaders,
      },
    )
    expect(revokeKeyRes.status).toBe(200)

    // 5. Create Plan -> audit: plan.created
    const createPlanRes = await request('/v1/admin/products/testprod/plans', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        slug: 'pro',
        name: 'Pro Plan',
        amount_paise: 99900,
      }),
    })
    expect(createPlanRes.status).toBe(201)

    // 6. Update Plan -> audit: plan.updated
    const updatePlanRes = await request('/v1/admin/products/testprod/plans/pro', {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'Pro Plan V2' }),
    })
    expect(updatePlanRes.status).toBe(200)

    // Fetch audit logs via GET /v1/admin/audit-logs
    const auditLogsRes = await request('/v1/admin/audit-logs', {
      headers: { 'X-Admin-Token': 'secret-admin-token' },
    })
    expect(auditLogsRes.status).toBe(200)
    const auditBody = (await auditLogsRes.json()) as any

    expect(auditBody.audit_logs.length).toBe(6)
    expect(auditBody.pagination).toEqual({ limit: 25, offset: 0, total: 6 })

    const actions = auditBody.audit_logs.map((log: any) => log.action)
    expect(actions).toContain('product.created')
    expect(actions).toContain('product.updated')
    expect(actions).toContain('key.minted')
    expect(actions).toContain('key.revoked')
    expect(actions).toContain('plan.created')
    expect(actions).toContain('plan.updated')

    // Test filter by product_id
    const filterProdRes = await request(
      `/v1/admin/audit-logs?product_id=${prod.id}&limit=2`,
      {
        headers: { 'X-Admin-Token': 'secret-admin-token' },
      },
    )
    const filterProdBody = (await filterProdRes.json()) as any
    expect(filterProdBody.pagination).toEqual({ limit: 2, offset: 0, total: 6 })
    expect(filterProdBody.audit_logs.length).toBe(2)

    // Test filter by action
    const filterActionRes = await request(
      '/v1/admin/audit-logs?action=key.minted',
      {
        headers: { 'X-Admin-Token': 'secret-admin-token' },
      },
    )
    const filterActionBody = (await filterActionRes.json()) as any
    expect(filterActionBody.pagination).toEqual({ limit: 25, offset: 0, total: 1 })
    expect(filterActionBody.audit_logs[0].action).toBe('key.minted')
  })

  it('supports pagination on GET /v1/payments and GET /v1/admin/products/:slug/payments', async () => {
    const db = await setupTestDb()
    const app = createTestApp(db, { ALLOW_DEV_CHARGE: '1' })

    const request = (path: string, options: RequestInit = {}) => {
      return app.request(`http://localhost${path}`, options)
    }

    const adminHeaders = {
      'X-Admin-Token': 'secret-admin-token',
      'Content-Type': 'application/json',
    }

    // Create product and key
    const prodRes = await request('/v1/admin/products', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ slug: 'pagetest', name: 'Page Test' }),
    })
    const prod = (await prodRes.json()) as any

    const minted = await mintApiKey('live')
    await db.exec(
      `INSERT INTO api_keys (id, product_id, name, key_prefix, key_hash, environment) VALUES (?, ?, ?, ?, ?, ?)`,
      ['key_1', prod.id, 'Live Key', minted.prefix, minted.hash, 'live'],
    )

    // Create 3 payments
    for (let i = 1; i <= 3; i++) {
      await db.exec(
        `INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`pay_${i}`, prod.id, 'key_1', 1000 * i, 'INR', 'paid', `2026-08-24T10:0${i}:00.000Z`],
      )
    }

    // Test GET /v1/payments with limit & offset
    const userHeaders = {
      Authorization: `Bearer ${minted.raw}`,
    }

    const userPayRes = await request('/v1/payments?limit=2&offset=1', {
      headers: userHeaders,
    })
    expect(userPayRes.status).toBe(200)
    const userPayBody = (await userPayRes.json()) as any
    expect(userPayBody.pagination).toEqual({ limit: 2, offset: 1, total: 3 })
    expect(userPayBody.payments.length).toBe(2)

    // Test GET /v1/admin/products/:slug/payments with limit & offset
    const adminPayRes = await request('/v1/admin/products/pagetest/payments?limit=1&offset=0', {
      headers: adminHeaders,
    })
    expect(adminPayRes.status).toBe(200)
    const adminPayBody = (await adminPayRes.json()) as any
    expect(adminPayBody.pagination).toEqual({ limit: 1, offset: 0, total: 3 })
    expect(adminPayBody.payments.length).toBe(1)
  })
})
