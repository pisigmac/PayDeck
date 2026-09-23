import { hmacSha256Hex, newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

export const BACKOFF_DELAYS_SECONDS = [60, 300, 900, 3600, 21600, 86400]

export interface EnqueueWebhookOptions {
  productId?: string
  product_id?: string
  event: string
  payload: string | Record<string, unknown>
  url: string
}

export interface WebhookDeliveryRow {
  id: string
  product_id: string
  event: string
  payload: string
  url: string
  status: string
  attempts: number
  last_attempt_at?: string | null
  next_retry_at?: string | null
  last_error?: string | null
  created_at: string
}

export async function enqueueWebhookDelivery(
  db: DatabaseAdapter,
  opts: EnqueueWebhookOptions,
): Promise<string> {
  const productId = opts.productId || opts.product_id
  if (!productId) {
    throw new Error('productId is required for enqueueWebhookDelivery')
  }

  const id = newId('whd')
  const nowIso = new Date().toISOString()
  const payloadStr = typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload)

  await db.exec(
    `INSERT INTO webhook_deliveries (id, product_id, event, payload, url, status, attempts, next_retry_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [id, productId, opts.event, payloadStr, opts.url, nowIso, nowIso],
  )

  return id
}

export async function processWebhookDeliveries(
  db: DatabaseAdapter,
  fetchFn: typeof fetch = fetch,
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const nowIso = new Date().toISOString()
  const rows = await db.query<WebhookDeliveryRow>(
    `SELECT id, product_id, event, payload, url, status, attempts, last_attempt_at, next_retry_at, last_error, created_at
     FROM webhook_deliveries
     WHERE status IN ('pending', 'failed') AND (next_retry_at IS NULL OR next_retry_at <= ?) AND attempts < 6
     ORDER BY next_retry_at ASC LIMIT 50`,
    [nowIso],
  )

  let delivered = 0
  let failed = 0

  for (const row of rows) {
    const product = await db.first<{ webhook_secret: string | null }>(
      `SELECT webhook_secret FROM products WHERE id = ?`,
      [row.product_id],
    )

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-PayDeck-Event': row.event,
    }
    if (product?.webhook_secret) {
      headers['X-PayDeck-Signature'] = await hmacSha256Hex(product.webhook_secret, row.payload)
    }

    const attempt = row.attempts + 1
    const attemptIso = new Date().toISOString()

    try {
      const res = await fetchFn(row.url, {
        method: 'POST',
        headers,
        body: row.payload,
      })

      if (res.ok) {
        delivered++
        await db.exec(
          `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_attempt_at = ?, next_retry_at = NULL, last_error = NULL WHERE id = ?`,
          [attempt, attemptIso, row.id],
        )
      } else {
        failed++
        const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
        const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
        const errorMsg = `HTTP ${res.status}: ${res.statusText || 'Response not OK'}`

        await db.exec(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
          [attempt, attemptIso, nextRetry, errorMsg, row.id],
        )
      }
    } catch (e) {
      failed++
      const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
      const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
      const errorMsg = (e as Error).message || String(e)

      await db.exec(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
        [attempt, attemptIso, nextRetry, errorMsg, row.id],
      )
    }
  }

  return { attempted: rows.length, delivered, failed }
}

export async function redeliverWebhook(
  db: DatabaseAdapter,
  deliveryId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ success: boolean; status?: number; error?: string }> {
  const row = await db.first<WebhookDeliveryRow>(
    `SELECT id, product_id, event, payload, url, status, attempts, last_attempt_at, next_retry_at, last_error, created_at
     FROM webhook_deliveries WHERE id = ?`,
    [deliveryId],
  )

  if (!row) {
    return { success: false, error: 'webhook_delivery_not_found' }
  }

  const product = await db.first<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM products WHERE id = ?`,
    [row.product_id],
  )

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-PayDeck-Event': row.event,
  }
  if (product?.webhook_secret) {
    headers['X-PayDeck-Signature'] = await hmacSha256Hex(product.webhook_secret, row.payload)
  }

  const attempt = row.attempts + 1
  const attemptIso = new Date().toISOString()

  try {
    const res = await fetchFn(row.url, {
      method: 'POST',
      headers,
      body: row.payload,
    })

    if (res.ok) {
      await db.exec(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_attempt_at = ?, next_retry_at = NULL, last_error = NULL WHERE id = ?`,
        [attempt, attemptIso, row.id],
      )
      return { success: true, status: res.status }
    } else {
      const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
      const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
      const errorMsg = `HTTP ${res.status}: ${res.statusText || 'Response not OK'}`

      await db.exec(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
        [attempt, attemptIso, nextRetry, errorMsg, row.id],
      )
      return { success: false, status: res.status, error: errorMsg }
    }
  } catch (e) {
    const delay = BACKOFF_DELAYS_SECONDS[Math.min(attempt - 1, BACKOFF_DELAYS_SECONDS.length - 1)]
    const nextRetry = new Date(Date.now() + delay * 1000).toISOString()
    const errorMsg = (e as Error).message || String(e)

    await db.exec(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
      [attempt, attemptIso, nextRetry, errorMsg, row.id],
    )
    return { success: false, error: errorMsg }
  }
}
