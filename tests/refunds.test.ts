import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { billingRoutes } from '../src/routes/billing'
import { adminRoutes } from '../src/routes/admin'
import { webhookRoutes } from '../src/routes/webhooks'
import { SQLiteAdapter } from '../src/db/sqlite'
import { mintApiKey } from '../src/crypto'
import { loadConfig } from '../src/config/env'
import { PayDeckClient } from '../src/client'
import type { AppVariables } from '../src/types'

async function setupTestApp() {
  const db = new SQLiteAdapter(':memory:')

  await db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rate_limit_per_hour INTEGER NOT NULL DEFAULT 200,
      active INTEGER NOT NULL DEFAULT 1,
      webhook_url TEXT,
      webhook_secret TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE api_keys (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'live',
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (product_id) REFERENCES products(id)
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
      FOREIGN KEY (product_id) REFERENCES products(id),
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
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (product_id) REFERENCES products(id)
    );

    CREATE TABLE refunds (
      id TEXT PRIMARY KEY,
      payment_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      amount_paise INTEGER NOT NULL,
      gateway_refund_id TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'processed',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      FOREIGN KEY (payment_id) REFERENCES payments(id)
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
  `)

  const config = loadConfig({
    ALLOW_DEV_CHARGE: '1',
    BILLING_ADMIN_TOKEN: 'admin_secret_token',
  })

  // Insert product and key
  await db.exec(`
    INSERT INTO products (id, slug, name, rate_limit_per_hour, active)
    VALUES ('prod_test_1', 'acme', 'Acme Corp', 200, 1)
  `)

  const mintedKey = await mintApiKey('live')
  await db.exec(`
    INSERT INTO api_keys (id, product_id, name, key_prefix, key_hash, environment)
    VALUES ('key_test_1', 'prod_test_1', 'Live Key', ?, ?, 'live')
  `, [mintedKey.prefix, mintedKey.hash])

  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', async (c, next) => {
    c.set('config', config)
    c.set('db', db)
    await next()
  })

  app.route('/v1/webhooks', webhookRoutes)
  app.route('/v1/admin', adminRoutes)
  app.route('/v1', billingRoutes)

  return { app, db, apiKey: mintedKey.raw, adminToken: 'admin_secret_token' }
}

describe('Refund API & Downstream Webhook Fan-Out', () => {
  it('processes full refund via product key endpoint and updates status/table/audit_log', async () => {
    const { app, db, apiKey } = await setupTestApp()

    // Insert a paid payment
    await db.exec(`
      INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, razorpay_order_id, razorpay_payment_id)
      VALUES ('pay_full_1', 'prod_test_1', 'key_test_1', 1000, 'INR', 'paid', 'order_dev_100', 'pay_dev_100')
    `)

    const res = await app.request('/v1/payments/pay_full_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ reason: 'Customer requested cancellation' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.refund).toBeDefined()
    expect(body.refund.amount_paise).toBe(1000)
    expect(body.refund.reason).toBe('Customer requested cancellation')
    expect(body.refund.gateway_refund_id).toContain('rfnd_dev_')
    expect(body.payment.status).toBe('refunded')

    // Verify DB records
    const dbPayment = await db.first<{ status: string }>(`SELECT status FROM payments WHERE id = 'pay_full_1'`)
    expect(dbPayment?.status).toBe('refunded')

    const dbRefund = await db.first<{ amount_paise: number; reason: string }>(
      `SELECT amount_paise, reason FROM refunds WHERE payment_id = 'pay_full_1'`,
    )
    expect(dbRefund?.amount_paise).toBe(1000)
    expect(dbRefund?.reason).toBe('Customer requested cancellation')

    const auditLog = await db.first<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_logs WHERE target_id = 'pay_full_1' AND action = 'payment.refunded'`,
    )
    expect(auditLog?.action).toBe('payment.refunded')
    expect(auditLog?.actor).toBe('key:key_test_1')
  })

  it('handles partial refunds correctly', async () => {
    const { app, db, apiKey } = await setupTestApp()

    await db.exec(`
      INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, razorpay_order_id, razorpay_payment_id)
      VALUES ('pay_partial_1', 'prod_test_1', 'key_test_1', 2000, 'INR', 'paid', 'order_dev_200', 'pay_dev_200')
    `)

    // First partial refund of 800 paise
    const res1 = await app.request('/v1/payments/pay_partial_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amount_paise: 800, reason: 'Partial return' }),
    })
    expect(res1.status).toBe(200)
    const body1 = (await res1.json()) as any
    expect(body1.payment.status).toBe('partially_refunded')
    expect(body1.refund.amount_paise).toBe(800)

    // Second partial refund of remaining 1200 paise
    const res2 = await app.request('/v1/payments/pay_partial_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amount_paise: 1200, reason: 'Final refund' }),
    })
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as any
    expect(body2.payment.status).toBe('refunded')
    expect(body2.refund.amount_paise).toBe(1200)
  })

  it('rejects refund when payment is unpaid or already refunded', async () => {
    const { app, db, apiKey } = await setupTestApp()

    // Unpaid payment
    await db.exec(`
      INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_created_1', 'prod_test_1', 'key_test_1', 1000, 'INR', 'created', 'order_dev_300')
    `)

    const resUnpaid = await app.request('/v1/payments/pay_created_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })
    expect(resUnpaid.status).toBe(400)

    // Fully refunded payment
    await db.exec(`
      INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_already_1', 'prod_test_1', 'key_test_1', 1000, 'INR', 'refunded', 'order_dev_301')
    `)

    const resRefunded = await app.request('/v1/payments/pay_already_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    })
    expect(resRefunded.status).toBe(400)
  })

  it('rejects refund amount exceeding remaining refundable amount', async () => {
    const { app, db, apiKey } = await setupTestApp()

    await db.exec(`
      INSERT INTO payments (id, product_id, api_key_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_exceed_1', 'prod_test_1', 'key_test_1', 1000, 'INR', 'paid', 'order_dev_400')
    `)

    const resExceed = await app.request('/v1/payments/pay_exceed_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ amount_paise: 1500 }),
    })
    expect(resExceed.status).toBe(400)
    const data = (await resExceed.json()) as any
    expect(data.error).toBe('refund_amount_exceeds_payment')
  })

  it('processes admin-initiated refund via POST /v1/admin/payments/:id/refund', async () => {
    const { app, db, adminToken } = await setupTestApp()

    await db.exec(`
      INSERT INTO payments (id, product_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_admin_1', 'prod_test_1', 3000, 'INR', 'paid', 'order_dev_500')
    `)

    const res = await app.request('/v1/admin/payments/pay_admin_1/refund', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken,
      },
      body: JSON.stringify({ reason: 'Admin adjustment' }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ok).toBe(true)
    expect(body.payment.status).toBe('refunded')

    const auditLog = await db.first<{ actor: string }>(
      `SELECT actor FROM audit_logs WHERE target_id = 'pay_admin_1' AND action = 'payment.refunded'`,
    )
    expect(auditLog?.actor).toBe('admin')
  })

  it('SDK method refundPayment works correctly', async () => {
    const { app, db, apiKey } = await setupTestApp()

    await db.exec(`
      INSERT INTO payments (id, product_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_sdk_1', 'prod_test_1', 5000, 'INR', 'paid', 'order_dev_600')
    `)

    const client = new PayDeckClient({
      baseUrl: 'http://localhost',
      apiKey,
      fetch: async (url, init) => app.request(url.toString(), init),
    })

    const result = await client.refundPayment('pay_sdk_1', {
      amount_paise: 2000,
      reason: 'SDK Partial Refund',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const paymentData = result.data.payment as { status: string }
      const refundData = result.data.refund as { amount_paise: number; reason: string }
      expect(paymentData.status).toBe('partially_refunded')
      expect(refundData.amount_paise).toBe(2000)
      expect(refundData.reason).toBe('SDK Partial Refund')
    }
  })

  it('dispatches downstream webhook when payment transitions to paid', async () => {
    const { app, db } = await setupTestApp()

    // Configure product with webhook_url
    await db.exec(`
      UPDATE products SET webhook_url = 'https://webhook.site/test', webhook_secret = 'secret_wh' WHERE id = 'prod_test_1'
    `)

    await db.exec(`
      INSERT INTO payments (id, product_id, amount_paise, currency, status, razorpay_order_id)
      VALUES ('pay_webhook_1', 'prod_test_1', 1500, 'INR', 'created', 'order_dev_700')
    `)

    const originalFetch = globalThis.fetch
    let webhookDispatched = false
    let dispatchedPayload: any = null

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (String(url) === 'https://webhook.site/test') {
        webhookDispatched = true
        dispatchedPayload = JSON.parse(String(init?.body || '{}'))
        return { ok: true, status: 200 } as Response
      }
      return originalFetch(url, init)
    })

    try {
      const res = await app.request('/v1/webhooks/razorpay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'payment.captured',
          payload: {
            payment: {
              entity: {
                id: 'pay_rzp_webhook_700',
                order_id: 'order_dev_700',
              },
            },
          },
        }),
      })

      expect(res.status).toBe(200)

      // Allow async task dispatch to run
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(webhookDispatched).toBe(true)
      expect(dispatchedPayload.event).toBe('payment.paid')
      expect(dispatchedPayload.data.id).toBe('pay_webhook_1')
      expect(dispatchedPayload.data.status).toBe('paid')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
