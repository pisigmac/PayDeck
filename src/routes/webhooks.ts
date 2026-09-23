import { Hono } from 'hono'
import { verifyWebhookSignature } from '../razorpay'
import { dispatchDownstreamWebhook } from '../core/webhook-dispatcher'
import { paymentResponse } from './billing'
import type { AppVariables, PaymentRow } from '../types'

export const webhookRoutes = new Hono<{ Variables: AppVariables }>()

/**
 * Razorpay webhook receiver.
 * Verifies X-Razorpay-Signature when RAZORPAY_WEBHOOK_SECRET is set.
 * Marks matching payments paid on payment.captured / order.paid.
 */
webhookRoutes.post('/razorpay', async (c) => {
  const db = c.get('db')
  const config = c.get('config')
  const rawBody = await c.req.text()
  const secret = config.razorpayWebhookSecret

  if (secret) {
    const signature = c.req.header('X-Razorpay-Signature')
    if (!signature) {
      return c.json(
        {
          error: 'missing_webhook_signature',
          code: 'MISSING_WEBHOOK_SIGNATURE',
          message: 'X-Razorpay-Signature header is required',
        },
        401,
      )
    }
    const ok = await verifyWebhookSignature(secret, rawBody, signature)
    if (!ok) {
      return c.json(
        {
          error: 'invalid_webhook_signature',
          code: 'INVALID_WEBHOOK_SIGNATURE',
          message: 'Webhook signature verification failed',
        },
        400,
      )
    }
  }

  let payload: {
    event?: string
    payload?: {
      payment?: { entity?: Record<string, unknown> }
      order?: { entity?: Record<string, unknown> }
    }
  }
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const event = payload.event || ''
  const paymentEntity = payload.payload?.payment?.entity
  const orderEntity = payload.payload?.order?.entity

  let orderId: string | null = null
  let razorpayPaymentId: string | null = null

  if (paymentEntity) {
    orderId = paymentEntity.order_id ? String(paymentEntity.order_id) : null
    razorpayPaymentId = paymentEntity.id ? String(paymentEntity.id) : null
  }
  if (!orderId && orderEntity?.id) {
    orderId = String(orderEntity.id)
  }

  const paidEvents = new Set([
    'payment.captured',
    'payment.authorized',
    'order.paid',
  ])

  if (!orderId || !paidEvents.has(event)) {
    return c.json({ ok: true, ignored: true, event })
  }

  const row = await db.first<PaymentRow>(
    `SELECT * FROM payments WHERE razorpay_order_id = ? LIMIT 1`,
    [orderId],
  )

  if (!row) {
    return c.json({ ok: true, matched: false, event })
  }

  if (row.status !== 'paid') {
    const nowIso = new Date().toISOString()
    await db.exec(
      `UPDATE payments SET
         razorpay_payment_id = COALESCE(?, razorpay_payment_id),
         status = 'paid',
         confirmed_at = ?
       WHERE id = ?`,
      [razorpayPaymentId, nowIso, row.id],
    )
    const updated = await db.first<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [row.id])
    if (updated) {
      try {
        const product = await db.first<{ webhook_url: string | null; webhook_secret: string | null }>(
          `SELECT webhook_url, webhook_secret FROM products WHERE id = ?`,
          [updated.product_id],
        )
        if (product?.webhook_url) {
          void dispatchDownstreamWebhook({
            webhookUrl: product.webhook_url,
            webhookSecret: product.webhook_secret,
            event: 'payment.paid',
            data: paymentResponse(updated),
          })
        }
      } catch {
        // Ignored if products table doesn't exist in minimal test environment
      }
    }
  }

  return c.json({ ok: true, matched: true, payment_id: row.id, event })
})
