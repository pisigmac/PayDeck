import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { CreateCustomerSchema, CurrencySchema } from '../src/schemas'
import { CreateOrderSchema } from '../src/core/validation'
import { billingRoutes } from '../src/routes/billing'
import { SQLiteAdapter } from '../src/db/sqlite'
import { sha256Hex } from '../src/crypto'
import type { AppVariables } from '../src/types'
import { loadConfig } from '../src/config/env'

const TEST_API_KEY = 'pd_live_testkey12345'

async function createTestApp() {
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
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      environment TEXT NOT NULL DEFAULT 'live',
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      external_user_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE payments (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      api_key_id TEXT,
      customer_id TEXT,
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

    CREATE TABLE rate_buckets (
      product_id TEXT NOT NULL,
      hour_bucket TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (product_id, hour_bucket)
    );

    INSERT INTO products (id, slug, name) VALUES ('prod_1', 'myproduct', 'My Product');
  `)

  const keyHash = await sha256Hex(TEST_API_KEY)
  const keyPrefix = TEST_API_KEY.slice(0, 14)
  await db.exec(
    `INSERT INTO api_keys (id, product_id, name, key_prefix, key_hash) VALUES ('key_1', 'prod_1', 'Default Key', ?, ?);`,
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

  return { app, db }
}

describe('Multi-Currency Validation & Customer Domain', () => {
  describe('Zod Schemas', () => {
    it('validates ISO-4217 3-letter currency codes', () => {
      expect(CurrencySchema.safeParse('USD').success).toBe(true)
      expect(CurrencySchema.safeParse('EUR').success).toBe(true)
      expect(CurrencySchema.safeParse('GBP').success).toBe(true)
      expect(CurrencySchema.safeParse('SGD').success).toBe(true)
      expect(CurrencySchema.safeParse('inr').success).toBe(true)

      expect(CurrencySchema.safeParse('US').success).toBe(false)
      expect(CurrencySchema.safeParse('USDT').success).toBe(false)
    })

    it('allows multi-currency orders in CreateOrderSchema', () => {
      const usdOrder = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'USD' })
      expect(usdOrder.success).toBe(true)
      if (usdOrder.success) expect(usdOrder.data.currency).toBe('USD')

      const eurOrder = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'EUR' })
      expect(eurOrder.success).toBe(true)
      if (eurOrder.success) expect(eurOrder.data.currency).toBe('EUR')

      const gbpOrder = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'GBP' })
      expect(gbpOrder.success).toBe(true)
      if (gbpOrder.success) expect(gbpOrder.data.currency).toBe('GBP')

      const sgdOrder = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'SGD' })
      expect(sgdOrder.success).toBe(true)
      if (sgdOrder.success) expect(sgdOrder.data.currency).toBe('SGD')
    })

    it('validates CreateCustomerSchema', () => {
      const valid = CreateCustomerSchema.safeParse({
        email: 'user@example.com',
        name: 'John Doe',
        external_user_id: 'usr_123',
        metadata: { role: 'admin' },
      })
      expect(valid.success).toBe(true)

      const empty = CreateCustomerSchema.safeParse({})
      expect(empty.success).toBe(true)

      const invalidEmail = CreateCustomerSchema.safeParse({ email: 'not-an-email' })
      expect(invalidEmail.success).toBe(false)
    })
  })

  describe('Customer API Endpoints', () => {
    it('creates a new customer via POST /v1/customers', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/v1/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          email: 'alice@example.com',
          name: 'Alice Smith',
          external_user_id: 'ext_alice',
          metadata: { plan: 'enterprise' },
        }),
      })

      expect(res.status).toBe(201)
      const data: any = await res.json()
      expect(data.id).toMatch(/^cust_/)
      expect(data.email).toBe('alice@example.com')
      expect(data.name).toBe('Alice Smith')
      expect(data.external_user_id).toBe('ext_alice')
      expect(data.metadata).toEqual({ plan: 'enterprise' })
    })

    it('upserts an existing customer when external_user_id matches', async () => {
      const { app } = await createTestApp()

      const createRes = await app.request('/v1/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          email: 'bob@example.com',
          name: 'Bob Original',
          external_user_id: 'ext_bob',
        }),
      })
      expect(createRes.status).toBe(201)
      const created: any = await createRes.json()

      const updateRes = await app.request('/v1/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          email: 'bob.new@example.com',
          name: 'Bob Updated',
          external_user_id: 'ext_bob',
        }),
      })
      expect(updateRes.status).toBe(200)
      const updated: any = await updateRes.json()
      expect(updated.id).toBe(created.id)
      expect(updated.email).toBe('bob.new@example.com')
      expect(updated.name).toBe('Bob Updated')
    })

    it('lists product customers with pagination via GET /v1/customers', async () => {
      const { app } = await createTestApp()

      for (let i = 1; i <= 3; i++) {
        await app.request('/v1/customers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({
            email: `user${i}@example.com`,
            name: `User ${i}`,
            external_user_id: `ext_${i}`,
          }),
        })
      }

      const listRes = await app.request('/v1/customers?limit=2&offset=0', {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      })
      expect(listRes.status).toBe(200)
      const listData: any = await listRes.json()
      expect(listData.customers.length).toBe(2)
      expect(listData.pagination.total).toBe(3)
      expect(listData.pagination.limit).toBe(2)
      expect(listData.pagination.offset).toBe(0)
    })

    it('returns customer payments via GET /v1/customers/:id/payments', async () => {
      const { app, db } = await createTestApp()

      const custRes = await app.request('/v1/customers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          email: 'cust_pay@example.com',
          name: 'Payer',
        }),
      })
      const custData: any = await custRes.json()
      const customerId = custData.id

      await db.exec(`
        INSERT INTO payments (id, product_id, api_key_id, customer_id, amount_paise, currency, status, razorpay_order_id, created_at)
        VALUES ('pay_cust_1', 'prod_1', 'key_1', '${customerId}', 1500, 'USD', 'paid', 'order_usd_1', '2026-08-24T10:00:00Z');
      `)

      const payRes = await app.request(`/v1/customers/${customerId}/payments`, {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      })
      expect(payRes.status).toBe(200)
      const payData: any = await payRes.json()
      expect(payData.payments.length).toBe(1)
      expect(payData.payments[0].id).toBe('pay_cust_1')
      expect(payData.payments[0].currency).toBe('USD')
      expect(payData.pagination.total).toBe(1)

      const notFoundRes = await app.request('/v1/customers/non_existent_cust/payments', {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      })
      expect(notFoundRes.status).toBe(404)
    })
  })

  describe('Multi-Currency Order Creation Endpoints', () => {
    it('creates orders in USD, EUR, GBP, and SGD', async () => {
      const { app } = await createTestApp()

      const currencies = ['USD', 'EUR', 'GBP', 'SGD']
      for (const curr of currencies) {
        const res = await app.request('/v1/orders', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${TEST_API_KEY}`,
          },
          body: JSON.stringify({
            amount_paise: 2500,
            currency: curr,
          }),
        })

        expect(res.status).toBe(201)
        const data: any = await res.json()
        expect(data.currency).toBe(curr)
        expect(data.payment.currency).toBe(curr)
      }
    })

    it('rejects invalid currency codes in order creation', async () => {
      const { app } = await createTestApp()

      const res = await app.request('/v1/orders', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
        body: JSON.stringify({
          amount_paise: 2500,
          currency: 'INVALID_CURRENCY',
        }),
      })

      expect(res.status).toBe(400)
      const data: any = await res.json()
      expect(data.error).toBe('unsupported_currency')
    })
  })
})
