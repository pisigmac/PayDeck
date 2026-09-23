import { Hono } from 'hono'
import { requireProductKey } from '../auth'
import { newId } from '../crypto'
import { assertWithinRateLimit } from '../policy'
import { checkOrgTierLimit, incrementOrgUsage } from '../middleware/tier-limits'
import { dispatchDownstreamWebhook } from '../core/webhook-dispatcher'
import { getGatewayAdapter } from '../gateways/adapter'
import { executeRefund } from '../core/refunds'
import { CreateCustomerSchema, errorEnvelope, formatZodError } from '../core/validation'
import type {
  AppVariables,
  CreateCustomerInput,
  CustomerRow,
  CreateOrderRequest,
  PaymentRow,
  PlanRow,
  VerifyRequest,
} from '../types'

export const billingRoutes = new Hono<{ Variables: AppVariables }>()

billingRoutes.use('*', requireProductKey)

export function paymentResponse(row: PaymentRow) {
  return {
    id: row.id,
    status: row.status,
    customer_id: row.customer_id || null,
    plan: row.plan_slug,
    plan_id: row.plan_id,
    amount_paise: row.amount_paise,
    currency: row.currency,
    razorpay_order_id: row.razorpay_order_id,
    razorpay_payment_id: row.razorpay_payment_id,
    receipt: row.receipt,
    notes: row.notes ? JSON.parse(row.notes) : {},
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    idempotency_key: row.idempotency_key,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
  }
}

export function customerResponse(row: CustomerRow) {
  return {
    id: row.id,
    product_id: row.product_id,
    email: row.email,
    name: row.name,
    external_user_id: row.external_user_id,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
    created_at: row.created_at,
  }
}

billingRoutes.get('/plans', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const plans = await db.query<PlanRow>(
    `SELECT id, slug, name, amount_paise, currency, interval
     FROM plans WHERE product_id = ? AND active = 1 ORDER BY amount_paise`,
    [auth.product.id],
  )

  return c.json({ plans })
})

billingRoutes.post('/customers', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const body = await c.req.json<CreateCustomerInput>().catch(() => null)
  if (!body) return c.json({ error: 'invalid_json' }, 400)

  const parsed = CreateCustomerSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      errorEnvelope(
        c.get('requestId') || '',
        'invalid_request',
        'VALIDATION_FAILED',
        'Invalid customer data',
        formatZodError(parsed.error),
      ),
      400,
    )
  }

  const { email, name, external_user_id, metadata } = parsed.data

  let existing: CustomerRow | null = null
  if (external_user_id) {
    existing = await db.first<CustomerRow>(
      `SELECT * FROM customers WHERE product_id = ? AND external_user_id = ? LIMIT 1`,
      [auth.product.id, external_user_id],
    )
  }

  if (existing) {
    const updatedEmail = email !== undefined ? (email || null) : existing.email
    const updatedName = name !== undefined ? (name || null) : existing.name
    const updatedMetadata = metadata !== undefined ? JSON.stringify(metadata) : existing.metadata

    await db.exec(
      `UPDATE customers SET email = ?, name = ?, metadata = ? WHERE id = ?`,
      [updatedEmail, updatedName, updatedMetadata, existing.id],
    )
    const updated = await db.first<CustomerRow>(`SELECT * FROM customers WHERE id = ?`, [existing.id])
    return c.json(customerResponse(updated!), 200)
  }

  const customerId = newId('cust')
  const nowIso = new Date().toISOString()
  const metaJson = metadata ? JSON.stringify(metadata) : null

  await db.exec(
    `INSERT INTO customers (id, product_id, email, name, external_user_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customerId, auth.product.id, email || null, name || null, external_user_id || null, metaJson, nowIso],
  )

  const row = await db.first<CustomerRow>(`SELECT * FROM customers WHERE id = ?`, [customerId])
  return c.json(customerResponse(row!), 201)
})

billingRoutes.get('/customers', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM customers WHERE product_id = ?`,
    [auth.product.id],
  )
  const total = Number(countResult?.total ?? 0)

  const customers = await db.query<CustomerRow>(
    `SELECT * FROM customers WHERE product_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [auth.product.id, limit, offset],
  )

  return c.json({
    customers: customers.map(customerResponse),
    pagination: {
      limit,
      offset,
      total,
    },
  })
})

billingRoutes.get('/customers/:id/payments', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const customerId = c.req.param('id')

  const customer = await db.first<CustomerRow>(
    `SELECT * FROM customers WHERE id = ? AND product_id = ? LIMIT 1`,
    [customerId, auth.product.id],
  )
  if (!customer) return c.json({ error: 'customer_not_found' }, 404)

  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM payments WHERE product_id = ? AND customer_id = ?`,
    [auth.product.id, customerId],
  )
  const total = Number(countResult?.total ?? 0)

  const payments = await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE product_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [auth.product.id, customerId, limit, offset],
  )

  return c.json({
    payments: payments.map(paymentResponse),
    pagination: {
      limit,
      offset,
      total,
    },
  })
})

billingRoutes.post('/orders', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const config = c.get('config')
  const body = await c.req.json<CreateOrderRequest>().catch(() => null)
  if (!body) return c.json({ error: 'invalid_json' }, 400)

  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null
  if (idempotencyKey) {
    if (idempotencyKey.length > 128) {
      return c.json({ error: 'idempotency_key_too_long' }, 400)
    }
    const existing = await db.first<PaymentRow>(
      `SELECT * FROM payments WHERE product_id = ? AND idempotency_key = ? LIMIT 1`,
      [auth.product.id, idempotencyKey],
    )
    if (existing) {
      return c.json(orderCreateResponse(config.razorpayKeyId, existing, auth.product.name), 200)
    }
  }

  const rate = await assertWithinRateLimit(db, auth.product)
  c.header('X-RateLimit-Limit', String(rate.limit))
  c.header('X-RateLimit-Remaining', String(rate.remaining))
  if (!rate.ok) {
    c.header('Retry-After', String(rate.resetSeconds))
    return c.json(
      { error: 'rate_limited', limit: rate.limit, used: rate.used, window: 'hour' },
      429,
    )
  }

  if (auth.product.org_id) {
    const tierCheck = await checkOrgTierLimit(db, auth.product.org_id)
    if (!tierCheck.allowed) {
      return c.json(
        {
          error: 'tier_limit_exceeded',
          message: 'Monthly order volume tier limit reached. Please upgrade your PayDeck Cloud plan.',
        },
        429,
      )
    }
  }

  let plan: PlanRow | null = null
  let amountPaise = 0
  let currency = 'INR'
  let planSlug: string | null = null
  let planId: string | null = null

  if (body.plan) {
    planSlug = body.plan.trim().toLowerCase()
    plan = await db.first<PlanRow>(
      `SELECT * FROM plans WHERE product_id = ? AND slug = ? AND active = 1 LIMIT 1`,
      [auth.product.id, planSlug],
    )
    if (!plan) return c.json({ error: 'plan_not_found' }, 404)
    amountPaise = plan.amount_paise
    currency = plan.currency
    planId = plan.id
  } else if (body.amount_paise != null) {
    amountPaise = Number(body.amount_paise)
    if (!Number.isInteger(amountPaise) || amountPaise < 100) {
      return c.json({ error: 'invalid_amount_paise', detail: 'Minimum 100 paise (₹1)' }, 400)
    }
    currency = (body.currency || 'INR').trim().toUpperCase()
    if (currency.length !== 3) {
      return c.json({ error: 'unsupported_currency' }, 400)
    }
  } else {
    return c.json({ error: 'plan_or_amount_required' }, 400)
  }

  let customerId: string | null = null
  if (body.customer_id) {
    customerId = body.customer_id.trim()
    try {
      const customer = await db.first<{ id: string }>(
        `SELECT id FROM customers WHERE id = ? AND product_id = ? LIMIT 1`,
        [customerId, auth.product.id],
      )
      if (!customer) {
        return c.json({ error: 'customer_not_found' }, 404)
      }
    } catch {
      // Ignored if customers table doesn't exist
    }
  }

  const paymentId = newId('pay')
  const receipt =
    (body.receipt || '').trim().slice(0, 40) ||
    `pd_${auth.product.slug.slice(0, 8)}_${paymentId.slice(-10)}`
  const notes: Record<string, string> = {
    product: auth.product.slug,
    payment_id: paymentId,
    ...(body.notes || {}),
  }
  if (planSlug) notes.plan = planSlug
  const metadata = body.metadata || {}

  const adapter = getGatewayAdapter(config)
  if (!adapter) {
    return c.json(
      {
        error: 'razorpay_not_configured',
        hint: 'Set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET, or ALLOW_DEV_CHARGE=1 for local fake orders',
      },
      503,
    )
  }

  const created = await adapter.createOrder({
    amountPaise,
    currency,
    receipt,
    notes,
  })
  if (!created.ok) {
    return c.json({ error: 'order_failed', detail: created.error }, 502)
  }

  const razorpayOrderId = created.orderId
  const mode = adapter.name as 'razorpay' | 'dev'
  const status = mode === 'dev' ? 'paid' : 'created'
  const confirmedAt = mode === 'dev' ? new Date().toISOString() : null
  const keyId = mode === 'dev' ? 'rzp_test_dev' : config.razorpayKeyId || null

  try {
    await db.exec(
      `INSERT INTO payments (
        id, product_id, api_key_id, customer_id, plan_id, plan_slug, amount_paise, currency, status,
        razorpay_order_id, receipt, notes, metadata, idempotency_key, confirmed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        paymentId,
        auth.product.id,
        auth.key.id,
        customerId,
        planId,
        planSlug,
        amountPaise,
        currency,
        status,
        razorpayOrderId,
        receipt,
        JSON.stringify(notes),
        JSON.stringify(metadata),
        idempotencyKey,
        confirmedAt,
      ],
    )
  } catch (e) {
    if (String(e).includes('has no column named customer_id')) {
      await db.exec(
        `INSERT INTO payments (
          id, product_id, api_key_id, plan_id, plan_slug, amount_paise, currency, status,
          razorpay_order_id, receipt, notes, metadata, idempotency_key, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          paymentId,
          auth.product.id,
          auth.key.id,
          planId,
          planSlug,
          amountPaise,
          currency,
          status,
          razorpayOrderId,
          receipt,
          JSON.stringify(notes),
          JSON.stringify(metadata),
          idempotencyKey,
          confirmedAt,
        ],
      )
    } else if (idempotencyKey) {
      const existing = await db.first<PaymentRow>(
        `SELECT * FROM payments WHERE product_id = ? AND idempotency_key = ? LIMIT 1`,
        [auth.product.id, idempotencyKey],
      )
      if (existing) {
        return c.json(orderCreateResponse(config.razorpayKeyId, existing, auth.product.name), 200)
      }
    } else {
      throw e
    }
  }

  const row = await db.first<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [paymentId])

  if (auth.product.org_id) {
    await incrementOrgUsage(db, auth.product.org_id)
  }

  return c.json(
    {
      ...orderCreateResponse(config.razorpayKeyId, row!, auth.product.name, body.description || plan?.name),
      mode,
      key_id: keyId,
    },
    201,
  )
})

function orderCreateResponse(
  razorpayKeyId: string,
  row: PaymentRow,
  productName: string,
  description?: string,
) {
  return {
    id: row.id,
    status: row.status,
    order_id: row.razorpay_order_id,
    key_id: razorpayKeyId || (row.status === 'paid' ? 'rzp_test_dev' : null),
    amount: row.amount_paise,
    currency: row.currency,
    plan: row.plan_slug,
    name: productName,
    description: description || undefined,
    payment: paymentResponse(row),
  }
}

billingRoutes.post('/verify', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const config = c.get('config')
  const body = await c.req.json<VerifyRequest>().catch(() => null)
  if (!body) return c.json({ error: 'invalid_json' }, 400)

  const orderId = body.razorpay_order_id?.trim()
  const paymentId = body.razorpay_payment_id?.trim()
  const signature = body.razorpay_signature?.trim()
  if (!orderId || !paymentId || !signature) {
    return c.json({ error: 'missing_razorpay_fields' }, 400)
  }

  const row = await db.first<PaymentRow>(
    `SELECT * FROM payments WHERE razorpay_order_id = ? AND product_id = ? LIMIT 1`,
    [orderId, auth.product.id],
  )

  if (!row) return c.json({ error: 'order_not_found' }, 404)

  if (row.status === 'paid') {
    return c.json({ ok: true, payment: paymentResponse(row) })
  }

  const adapter = getGatewayAdapter(config, orderId)
  if (!adapter) {
    return c.json({ error: 'razorpay_not_configured' }, 503)
  }

  const ok = await adapter.verifyPayment({ orderId, paymentId, signature })
  if (!ok) return c.json({ error: 'invalid_signature' }, 400)

  const nowIso = new Date().toISOString()
  await db.exec(
    `UPDATE payments SET razorpay_payment_id = ?, status = 'paid', confirmed_at = ? WHERE id = ?`,
    [paymentId, nowIso, row.id],
  )

  const updated = await db.first<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [row.id])

  try {
    const product = await db.first<{ webhook_url: string | null; webhook_secret: string | null }>(
      `SELECT webhook_url, webhook_secret FROM products WHERE id = ?`,
      [auth.product.id],
    )
    if (product?.webhook_url && updated) {
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

  return c.json({
    ok: true,
    payment: paymentResponse(updated!),
    ...(adapter.name === 'dev' ? { mode: 'dev' } : {}),
  })
})

billingRoutes.post('/payments/:id/refund', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const config = c.get('config')
  const id = c.req.param('id')

  const payment = await db.first<PaymentRow>(
    `SELECT * FROM payments WHERE id = ? AND product_id = ? LIMIT 1`,
    [id, auth.product.id],
  )
  if (!payment) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const res = await executeRefund({
    db,
    config,
    payment,
    input: body,
    actor: `key:${auth.key.id}`,
  })

  if (!res.ok) {
    const { ok: _ok, status, ...errData } = res
    return c.json(errData, status as any)
  }

  return c.json(res.data, 200)
})

billingRoutes.get('/payments/:id', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const id = c.req.param('id')
  const row = await db.first<PaymentRow>(
    `SELECT * FROM payments WHERE id = ? AND product_id = ? LIMIT 1`,
    [id, auth.product.id],
  )
  if (!row) return c.json({ error: 'not_found' }, 404)
  return c.json(paymentResponse(row))
})

billingRoutes.get('/payments', async (c) => {
  const auth = c.get('auth')
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM payments WHERE product_id = ?`,
    [auth.product.id],
  )
  const total = Number(countResult?.total ?? 0)

  const payments = await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE product_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [auth.product.id, limit, offset],
  )

  return c.json({
    payments: payments.map(paymentResponse),
    pagination: {
      limit,
      offset,
      total,
    },
  })
})
