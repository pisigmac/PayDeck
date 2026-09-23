import { describe, expect, it, vi } from 'vitest'
import {
  BACKOFF_DELAYS_SECONDS,
  enqueueWebhookDelivery,
  processWebhookDeliveries,
  redeliverWebhook,
} from '../src/core/webhook-queue'
import { SQLiteAdapter } from '../src/db/sqlite'

async function setupTestDb() {
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

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      external_user_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX webhook_deliveries_status_idx ON webhook_deliveries(status, next_retry_at);
    CREATE INDEX customers_product_ext_idx ON customers(product_id, external_user_id);
  `)

  await db.exec(`
    INSERT INTO products (id, slug, name, webhook_secret)
    VALUES ('prod_1', 'acme', 'Acme Corp', 'secret_wh_123')
  `)

  return db
}

describe('Webhook Queue Runner', () => {
  it('enqueues webhook delivery correctly', async () => {
    const db = await setupTestDb()

    const deliveryId = await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'payment.paid',
      payload: { payment_id: 'pay_123', amount_paise: 1000 },
      url: 'https://example.com/webhook',
    })

    expect(deliveryId).toBeDefined()
    expect(deliveryId).toMatch(/^whd_/)

    const row = await db.first<{
      id: string
      product_id: string
      event: string
      payload: string
      url: string
      status: string
      attempts: number
    }>(`SELECT * FROM webhook_deliveries WHERE id = ?`, [deliveryId])

    expect(row).toBeDefined()
    expect(row?.product_id).toBe('prod_1')
    expect(row?.event).toBe('payment.paid')
    expect(JSON.parse(row?.payload || '{}')).toEqual({ payment_id: 'pay_123', amount_paise: 1000 })
    expect(row?.url).toBe('https://example.com/webhook')
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(0)
  })

  it('processes webhook delivery successfully', async () => {
    const db = await setupTestDb()

    await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'payment.paid',
      payload: JSON.stringify({ payment_id: 'pay_123' }),
      url: 'https://example.com/webhook',
    })

    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    const mockFetchSuccess = async (url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {}
      capturedBody = String(init?.body || '')
      return new Response(JSON.stringify({ received: true }), { status: 200 })
    }

    const result = await processWebhookDeliveries(db, mockFetchSuccess as typeof fetch)

    expect(result.attempted).toBe(1)
    expect(result.delivered).toBe(1)
    expect(result.failed).toBe(0)

    expect(capturedHeaders['X-PayDeck-Event']).toBe('payment.paid')
    expect(capturedHeaders['X-PayDeck-Signature']).toBeDefined()
    expect(capturedBody).toBe(JSON.stringify({ payment_id: 'pay_123' }))

    const delivery = await db.first<{ status: string; attempts: number; last_attempt_at: string; last_error: string | null }>(
      `SELECT status, attempts, last_attempt_at, last_error FROM webhook_deliveries LIMIT 1`,
    )
    expect(delivery?.status).toBe('delivered')
    expect(delivery?.attempts).toBe(1)
    expect(delivery?.last_attempt_at).toBeDefined()
    expect(delivery?.last_error).toBeNull()
  })

  it('handles failed delivery with exponential backoff retry scheduling', async () => {
    const db = await setupTestDb()

    const deliveryId = await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'payment.failed',
      payload: JSON.stringify({ payment_id: 'pay_456' }),
      url: 'https://example.com/failed-webhook',
    })

    const mockFetchFail = async () => new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' })

    const startTime = Date.now()
    const result = await processWebhookDeliveries(db, mockFetchFail as typeof fetch)

    expect(result.attempted).toBe(1)
    expect(result.delivered).toBe(0)
    expect(result.failed).toBe(1)

    const delivery = await db.first<{
      status: string
      attempts: number
      next_retry_at: string
      last_error: string
    }>(`SELECT status, attempts, next_retry_at, last_error FROM webhook_deliveries WHERE id = ?`, [deliveryId])

    expect(delivery?.status).toBe('failed')
    expect(delivery?.attempts).toBe(1)
    expect(delivery?.last_error).toBe('HTTP 500: Internal Server Error')

    // Verify exponential backoff for attempt 1 (60 seconds)
    const nextRetryTime = new Date(delivery!.next_retry_at).getTime()
    const diffSeconds = Math.round((nextRetryTime - startTime) / 1000)
    expect(diffSeconds).toBeGreaterThanOrEqual(58)
    expect(diffSeconds).toBeLessThanOrEqual(62)

    // Second processing run before next_retry_at should skip this delivery
    const result2 = await processWebhookDeliveries(db, mockFetchFail as typeof fetch)
    expect(result2.attempted).toBe(0)

    // Manually set next_retry_at to past to simulate time passing for attempt 2 retry
    const pastIso = new Date(Date.now() - 1000).toISOString()
    await db.exec(`UPDATE webhook_deliveries SET next_retry_at = ? WHERE id = ?`, [pastIso, deliveryId])

    const startTime2 = Date.now()
    const result3 = await processWebhookDeliveries(db, mockFetchFail as typeof fetch)
    expect(result3.attempted).toBe(1)
    expect(result3.failed).toBe(1)

    const delivery2 = await db.first<{ attempts: number; next_retry_at: string }>(
      `SELECT attempts, next_retry_at FROM webhook_deliveries WHERE id = ?`,
      [deliveryId],
    )
    expect(delivery2?.attempts).toBe(2)

    // Verify exponential backoff for attempt 2 (300 seconds)
    const nextRetryTime2 = new Date(delivery2!.next_retry_at).getTime()
    const diffSeconds2 = Math.round((nextRetryTime2 - startTime2) / 1000)
    expect(diffSeconds2).toBeGreaterThanOrEqual(298)
    expect(diffSeconds2).toBeLessThanOrEqual(302)
  })

  it('handles network exceptions during webhook processing', async () => {
    const db = await setupTestDb()

    const deliveryId = await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'subscription.created',
      payload: JSON.stringify({ sub_id: 'sub_123' }),
      url: 'https://invalid-domain.local/webhook',
    })

    const mockFetchNetworkError = async () => {
      throw new Error('Fetch failed: connection refused')
    }

    const result = await processWebhookDeliveries(db, mockFetchNetworkError as typeof fetch)

    expect(result.attempted).toBe(1)
    expect(result.delivered).toBe(0)
    expect(result.failed).toBe(1)

    const delivery = await db.first<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM webhook_deliveries WHERE id = ?`,
      [deliveryId],
    )
    expect(delivery?.status).toBe('failed')
    expect(delivery?.last_error).toBe('Fetch failed: connection refused')
  })

  it('redelivers webhook manually via redeliverWebhook', async () => {
    const db = await setupTestDb()

    const deliveryId = await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'payment.refunded',
      payload: JSON.stringify({ refund_id: 'rfnd_123' }),
      url: 'https://example.com/webhook',
    })

    // First attempt fails
    await processWebhookDeliveries(db, (async () => new Response('Error', { status: 500 })) as typeof fetch)

    const failedRecord = await db.first<{ status: string }>(`SELECT status FROM webhook_deliveries WHERE id = ?`, [deliveryId])
    expect(failedRecord?.status).toBe('failed')

    // Force redeliver via redeliverWebhook with successful fetch
    const mockFetchSuccess = async () => new Response('OK', { status: 200 })
    const redeliverResult = await redeliverWebhook(db, deliveryId, mockFetchSuccess as typeof fetch)

    expect(redeliverResult.success).toBe(true)
    expect(redeliverResult.status).toBe(200)

    const successRecord = await db.first<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_deliveries WHERE id = ?`,
      [deliveryId],
    )
    expect(successRecord?.status).toBe('delivered')
    expect(successRecord?.attempts).toBe(2)
  })
})
