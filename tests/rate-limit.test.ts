import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { assertWithinRateLimit, secondsUntilNextHour } from '../src/policy'
import { billingRoutes } from '../src/routes/billing'
import { SQLiteAdapter } from '../src/db/sqlite'
import { sha256Hex } from '../src/crypto'
import { loadConfig } from '../src/config/env'
import type { AppVariables, ProductRow } from '../src/types'

describe('Rate Limit Logic and Headers', () => {
  describe('secondsUntilNextHour', () => {
    it('calculates seconds remaining until next UTC hour boundary', () => {
      const date1 = new Date('2026-08-24T20:15:30.000Z')
      expect(secondsUntilNextHour(date1)).toBe(2670)

      const date2 = new Date('2026-08-24T20:59:59.000Z')
      expect(secondsUntilNextHour(date2)).toBe(1)

      const date3 = new Date('2026-08-24T23:50:00.000Z')
      expect(secondsUntilNextHour(date3)).toBe(600)

      const nowSec = secondsUntilNextHour()
      expect(nowSec).toBeGreaterThan(0)
      expect(nowSec).toBeLessThanOrEqual(3600)
    })
  })

  describe('assertWithinRateLimit', () => {
    it('calculates limit, used, remaining, and resetSeconds accurately', async () => {
      const db = new SQLiteAdapter(':memory:')
      await db.exec(`
        CREATE TABLE rate_buckets (
          product_id TEXT NOT NULL,
          hour_bucket TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (product_id, hour_bucket)
        );
      `)

      const product: ProductRow = {
        id: 'prod_test',
        slug: 'test-product',
        name: 'Test Product',
        rate_limit_per_hour: 3,
        active: 1,
        created_at: '2026-08-24T00:00:00Z',
      }

      // First request: count 0 before, 1 after. remaining: 3 - 1 = 2
      const res1 = await assertWithinRateLimit(db, product)
      expect(res1.ok).toBe(true)
      expect(res1.limit).toBe(3)
      expect(res1.used).toBe(1)
      expect(res1.remaining).toBe(2)
      expect(res1.resetSeconds).toBeGreaterThan(0)

      // Second request: count 1 before, 2 after. remaining: 3 - 2 = 1
      const res2 = await assertWithinRateLimit(db, product)
      expect(res2.ok).toBe(true)
      expect(res2.limit).toBe(3)
      expect(res2.used).toBe(2)
      expect(res2.remaining).toBe(1)

      // Third request: count 2 before, 3 after. remaining: 3 - 3 = 0
      const res3 = await assertWithinRateLimit(db, product)
      expect(res3.ok).toBe(true)
      expect(res3.limit).toBe(3)
      expect(res3.used).toBe(3)
      expect(res3.remaining).toBe(0)

      // Fourth request: count 3 before (>= 3). ok: false, used: 3, remaining: 0
      const res4 = await assertWithinRateLimit(db, product)
      expect(res4.ok).toBe(false)
      expect(res4.limit).toBe(3)
      expect(res4.used).toBe(3)
      expect(res4.remaining).toBe(0)
      expect(res4.resetSeconds).toBeGreaterThan(0)

      await db.close?.()
    })
  })

  describe('Billing route rate limit headers', () => {
    async function setupApp(rateLimitPerHour = 2) {
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
      `)
      await db.exec(`
        CREATE TABLE api_keys (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          environment TEXT NOT NULL DEFAULT 'live',
          active INTEGER NOT NULL DEFAULT 1,
          revoked_at TEXT,
          last_used_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `)
      await db.exec(`
        CREATE TABLE rate_buckets (
          product_id TEXT NOT NULL,
          hour_bucket TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (product_id, hour_bucket)
        );
      `)
      await db.exec(`
        CREATE TABLE plans (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          name TEXT NOT NULL,
          amount_paise INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          interval TEXT NOT NULL DEFAULT 'month',
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `)
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

      await db.exec(
        `INSERT INTO products (id, slug, name, rate_limit_per_hour) VALUES ('prod_1', 'p1', 'Product 1', ?)`,
        [rateLimitPerHour],
      )

      const token = 'pd_live_testkey123'
      const keyHash = await sha256Hex(token)
      const keyPrefix = token.slice(0, 14)
      await db.exec(
        `INSERT INTO api_keys (id, product_id, name, key_hash, key_prefix) VALUES ('key_1', 'prod_1', 'Test Key', ?, ?)`,
        [keyHash, keyPrefix],
      )

      await db.exec(
        `INSERT INTO plans (id, product_id, slug, name, amount_paise) VALUES ('plan_1', 'prod_1', 'basic', 'Basic', 500)`,
      )

      const config = loadConfig({ ALLOW_DEV_CHARGE: '1', RATE_LIMIT_PER_HOUR: String(rateLimitPerHour) })

      const app = new Hono<{ Variables: AppVariables }>()
      app.use('*', async (c, next) => {
        c.set('config', config)
        c.set('db', db)
        await next()
      })
      app.route('/v1/billing', billingRoutes)

      const executionCtx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      }

      return { app, db, token, executionCtx }
    }

    it('sets X-RateLimit-Limit and X-RateLimit-Remaining on orders request', async () => {
      const { app, token, executionCtx } = await setupApp(2)

      const res1 = await app.request(
        '/v1/billing/orders',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ plan: 'basic' }),
        },
        undefined,
        executionCtx as any,
      )

      expect(res1.headers.get('X-RateLimit-Limit')).toBe('2')
      expect(res1.headers.get('X-RateLimit-Remaining')).toBe('1')
      expect(res1.headers.get('Retry-After')).toBeNull()

      const res2 = await app.request(
        '/v1/billing/orders',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ plan: 'basic' }),
        },
        undefined,
        executionCtx as any,
      )

      expect(res2.headers.get('X-RateLimit-Limit')).toBe('2')
      expect(res2.headers.get('X-RateLimit-Remaining')).toBe('0')
      expect(res2.headers.get('Retry-After')).toBeNull()

      // 3rd request exceeds limit -> 429
      const res3 = await app.request(
        '/v1/billing/orders',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ plan: 'basic' }),
        },
        undefined,
        executionCtx as any,
      )

      expect(res3.status).toBe(429)
      expect(res3.headers.get('X-RateLimit-Limit')).toBe('2')
      expect(res3.headers.get('X-RateLimit-Remaining')).toBe('0')
      expect(res3.headers.get('Retry-After')).not.toBeNull()
      const retryAfter = Number(res3.headers.get('Retry-After'))
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(3600)
    })
  })
})
