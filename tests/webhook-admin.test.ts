import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'
import { adminRoutes } from '../src/routes/admin'
import { SQLiteAdapter } from '../src/db/sqlite'
import type { AppVariables } from '../src/types'
import { loadConfig } from '../src/config/env'

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

    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
  `)

  const config = loadConfig({ BILLING_ADMIN_TOKEN: 'admin_secret_123' })

  const app = new Hono<{ Variables: AppVariables }>()
  app.use('*', async (c, next) => {
    c.set('config', config)
    c.set('db', db)
    await next()
  })
  app.route('/v1/admin', adminRoutes)

  return { app, db, config }
}

describe('Webhook Admin APIs', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('GET /v1/admin/webhooks', () => {
    it('returns 401 when admin token is missing or invalid', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/v1/admin/webhooks')
      expect(res.status).toBe(401)
    })

    it('returns empty deliveries list with default pagination when no records exist', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/v1/admin/webhooks', {
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      expect(data).toEqual({
        deliveries: [],
        pagination: {
          limit: 25,
          offset: 0,
          total: 0,
        },
      })
    })

    it('filters deliveries by status, product_id, and supports pagination', async () => {
      const { app, db } = await createTestApp()

      await db.exec(`
        INSERT INTO webhook_deliveries (id, product_id, event, payload, url, status, attempts, created_at)
        VALUES
          ('whd_1', 'prod_1', 'payment.paid', '{"pay_id":"p1"}', 'https://example.com/wh1', 'delivered', 1, '2026-08-24T10:00:00Z'),
          ('whd_2', 'prod_1', 'payment.failed', '{"pay_id":"p2"}', 'https://example.com/wh2', 'failed', 2, '2026-08-24T11:00:00Z'),
          ('whd_3', 'prod_2', 'payment.paid', '{"pay_id":"p3"}', 'https://example.com/wh3', 'pending', 0, '2026-08-24T12:00:00Z');
      `)

      // Filter status=failed
      const res1 = await app.request('/v1/admin/webhooks?status=failed', {
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })
      expect(res1.status).toBe(200)
      const data1: any = await res1.json()
      expect(data1.deliveries.length).toBe(1)
      expect(data1.deliveries[0].id).toBe('whd_2')
      expect(data1.deliveries[0].status).toBe('failed')
      expect(data1.pagination.total).toBe(1)

      // Filter product_id=prod_1
      const res2 = await app.request('/v1/admin/webhooks?product_id=prod_1', {
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })
      expect(res2.status).toBe(200)
      const data2: any = await res2.json()
      expect(data2.deliveries.length).toBe(2)
      expect(data2.pagination.total).toBe(2)

      // Limit and offset
      const res3 = await app.request('/v1/admin/webhooks?limit=1&offset=0', {
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })
      expect(res3.status).toBe(200)
      const data3: any = await res3.json()
      expect(data3.deliveries.length).toBe(1)
      expect(data3.pagination.total).toBe(3)
      expect(data3.pagination.limit).toBe(1)
      expect(data3.pagination.offset).toBe(0)
    })
  })

  describe('POST /v1/admin/webhooks/:id/redeliver', () => {
    it('returns 401 when admin token is missing', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/v1/admin/webhooks/whd_123/redeliver', {
        method: 'POST',
      })
      expect(res.status).toBe(401)
    })

    it('returns 404 for non-existent delivery id', async () => {
      const { app } = await createTestApp()
      const res = await app.request('/v1/admin/webhooks/non_existent_id/redeliver', {
        method: 'POST',
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })
      expect(res.status).toBe(404)
      const data: any = await res.json()
      expect(data.error).toBe('not_found')
    })

    it('triggers immediate POST attempt, updates status to delivered, and includes signature', async () => {
      const { app, db } = await createTestApp()

      await db.exec(`
        INSERT INTO products (id, slug, name, webhook_secret)
        VALUES ('prod_1', 'myproduct', 'My Product', 'sec_test_123');

        INSERT INTO webhook_deliveries (id, product_id, event, payload, url, status, attempts, created_at)
        VALUES ('whd_10', 'prod_1', 'payment.paid', '{"amount":500}', 'https://example.com/webhook', 'failed', 1, '2026-08-24T10:00:00Z');
      `)

      let capturedUrl = ''
      let capturedHeaders: Record<string, string> = {}
      let capturedBody = ''

      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        capturedUrl = url.toString()
        capturedHeaders = (init?.headers as Record<string, string>) || {}
        capturedBody = init?.body as string
        return new Response(JSON.stringify({ received: true }), { status: 200 })
      })

      const res = await app.request('/v1/admin/webhooks/whd_10/redeliver', {
        method: 'POST',
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })

      expect(res.status).toBe(200)
      const data: any = await res.json()
      expect(data.ok).toBe(true)
      expect(data.delivery.status).toBe('delivered')
      expect(data.delivery.attempts).toBe(2)

      expect(capturedUrl).toBe('https://example.com/webhook')
      expect(capturedHeaders['Content-Type']).toBe('application/json')
      expect(capturedHeaders['X-PayDeck-Event']).toBe('payment.paid')
      expect(capturedHeaders['X-PayDeck-Signature']).toBeDefined()
      expect(capturedBody).toBe('{"amount":500}')

      const updated = await db.first<{ status: string; attempts: number; last_error: string | null }>(
        `SELECT status, attempts, last_error FROM webhook_deliveries WHERE id = 'whd_10'`,
      )
      expect(updated?.status).toBe('delivered')
      expect(updated?.attempts).toBe(2)
      expect(updated?.last_error).toBeNull()
    })

    it('updates status to failed when redelivery target returns 500 error', async () => {
      const { app, db } = await createTestApp()

      await db.exec(`
        INSERT INTO webhook_deliveries (id, product_id, event, payload, url, status, attempts, created_at)
        VALUES ('whd_11', 'prod_1', 'payment.created', '{"id":"p1"}', 'https://example.com/fail', 'pending', 0, '2026-08-24T10:00:00Z');
      `)

      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
      )

      const res = await app.request('/v1/admin/webhooks/whd_11/redeliver', {
        method: 'POST',
        headers: { 'X-Admin-Token': 'admin_secret_123' },
      })

      expect(res.status).toBe(200)
      const data: any = await res.json()
      expect(data.ok).toBe(false)
      expect(data.delivery.status).toBe('failed')
      expect(data.delivery.attempts).toBe(1)
      expect(data.delivery.last_error).toContain('HTTP 500')

      const updated = await db.first<{ status: string; attempts: number; next_retry_at: string; last_error: string }>(
        `SELECT status, attempts, next_retry_at, last_error FROM webhook_deliveries WHERE id = 'whd_11'`,
      )
      expect(updated?.status).toBe('failed')
      expect(updated?.attempts).toBe(1)
      expect(updated?.next_retry_at).toBeDefined()
      expect(updated?.last_error).toContain('HTTP 500')
    })
  })
})
