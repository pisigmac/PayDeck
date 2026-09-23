import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { webhookRoutes } from '../src/routes/webhooks'
import { SQLiteAdapter } from '../src/db/sqlite'
import { hmacSha256Hex } from '../src/crypto'
import type { AppVariables } from '../src/types'
import { loadConfig } from '../src/config/env'

async function createTestApp(secret?: string) {
  const db = new SQLiteAdapter(':memory:')
  await db.exec(`
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
  `)

  const config = loadConfig(secret ? { RAZORPAY_WEBHOOK_SECRET: secret } : {})

  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', async (c, next) => {
    c.set('config', config)
    c.set('db', db)
    await next()
  })
  app.route('/v1/webhooks', webhookRoutes)

  return { app, db }
}

describe('Razorpay Webhook Route', () => {
  describe('when RAZORPAY_WEBHOOK_SECRET is set', () => {
    const secret = 'whsec_test_secret_123'

    it('returns 401 when X-Razorpay-Signature header is missing', async () => {
      const { app } = await createTestApp(secret)
      const res = await app.request('/v1/webhooks/razorpay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'payment.captured' }),
      })

      expect(res.status).toBe(401)
      const data = await res.json()
      expect(data).toEqual({
        error: 'missing_webhook_signature',
        code: 'MISSING_WEBHOOK_SIGNATURE',
        message: 'X-Razorpay-Signature header is required',
      })
    })

    it('returns 400 when X-Razorpay-Signature header is invalid', async () => {
      const { app } = await createTestApp(secret)
      const res = await app.request('/v1/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': 'invalid_signature_hash',
        },
        body: JSON.stringify({ event: 'payment.captured' }),
      })

      expect(res.status).toBe(400)
      const data = await res.json()
      expect(data).toEqual({
        error: 'invalid_webhook_signature',
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Webhook signature verification failed',
      })
    })

    it('succeeds when X-Razorpay-Signature header is valid', async () => {
      const { app, db } = await createTestApp(secret)
      await db.exec(
        `INSERT INTO payments (id, product_id, amount_paise, status, razorpay_order_id, created_at)
         VALUES ('pay_1', 'prod_1', 1000, 'created', 'order_123', '2026-08-24T00:00:00Z')`,
      )

      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'rzp_pay_999',
              order_id: 'order_123',
            },
          },
        },
      })
      const validSignature = await hmacSha256Hex(secret, body)

      const res = await app.request('/v1/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': validSignature,
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({
        ok: true,
        matched: true,
        payment_id: 'pay_1',
        event: 'payment.captured',
      })

      const updated = await db.first<{ status: string; razorpay_payment_id: string }>(
        `SELECT status, razorpay_payment_id FROM payments WHERE id = 'pay_1'`,
      )
      expect(updated?.status).toBe('paid')
      expect(updated?.razorpay_payment_id).toBe('rzp_pay_999')
    })
  })

  describe('when RAZORPAY_WEBHOOK_SECRET is absent', () => {
    it('processes webhooks without requiring X-Razorpay-Signature header', async () => {
      const { app, db } = await createTestApp(undefined)
      await db.exec(
        `INSERT INTO payments (id, product_id, amount_paise, status, razorpay_order_id, created_at)
         VALUES ('pay_2', 'prod_1', 2000, 'created', 'order_456', '2026-08-24T00:00:00Z')`,
      )

      const body = JSON.stringify({
        event: 'order.paid',
        payload: {
          order: {
            entity: {
              id: 'order_456',
            },
          },
        },
      })

      const res = await app.request('/v1/webhooks/razorpay', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body,
      })

      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data).toEqual({
        ok: true,
        matched: true,
        payment_id: 'pay_2',
        event: 'order.paid',
      })

      const updated = await db.first<{ status: string }>(
        `SELECT status FROM payments WHERE id = 'pay_2'`,
      )
      expect(updated?.status).toBe('paid')
    })
  })
})
