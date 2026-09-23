import { Hono } from 'hono'
import { requireAdmin } from '../auth'
import { logAudit } from '../core/audit'
import { hmacSha256Hex, mintApiKey, newId } from '../crypto'
import { isValidPlanInterval } from '../policy'
import { executeRefund } from '../core/refunds'
import { cancelSubscription, createSubscription, type SubscriptionRecord } from '../core/subscriptions'
import type { ApiKeyRow, AppVariables, AuditLogRow, CustomerRow, PaymentRow, PlanRow, ProductRow, WebhookDeliveryRow } from '../types'

export const adminRoutes = new Hono<{ Variables: AppVariables }>()

adminRoutes.use('*', requireAdmin)

adminRoutes.get('/audit-logs', async (c) => {
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const productId = c.req.query('product_id')?.trim()
  const action = c.req.query('action')?.trim()

  const conditions: string[] = []
  const params: unknown[] = []

  if (productId) {
    conditions.push('product_id = ?')
    params.push(productId)
  }
  if (action) {
    conditions.push('action = ?')
    params.push(action)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM audit_logs ${whereClause}`,
    params,
  )
  const total = Number(countResult?.total ?? 0)

  const rows = await db.query<AuditLogRow>(
    `SELECT id, product_id, actor, action, target_id, details, created_at
     FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  const auditLogs = rows.map((row) => ({
    ...row,
    details: row.details ? tryParseJson(row.details) : null,
  }))

  return c.json({
    audit_logs: auditLogs,
    pagination: {
      limit,
      offset,
      total,
    },
  })
})

adminRoutes.get('/products', async (c) => {
  const db = c.get('db')
  const results = await db.query<ProductRow>(
    `SELECT id, slug, name, rate_limit_per_hour, active, created_at FROM products ORDER BY created_at`,
  )
  return c.json({
    products: results.map((p) => ({
      ...p,
      active: !!p.active,
    })),
  })
})

adminRoutes.post('/products', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<{
    slug: string
    name: string
    rate_limit_per_hour?: number
  }>()

  const slug = (body.slug || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(slug)) {
    return c.json({ error: 'invalid_slug' }, 400)
  }
  const name = (body.name || slug).trim()
  const limit = Math.max(1, Math.min(100_000, body.rate_limit_per_hour ?? 200))
  const id = newId('prod')

  try {
    await db.exec(
      `INSERT INTO products (id, slug, name, rate_limit_per_hour) VALUES (?, ?, ?, ?)`,
      [id, slug, name, limit],
    )
  } catch {
    return c.json({ error: 'slug_taken' }, 409)
  }

  await logAudit(db, {
    productId: id,
    actor: 'admin',
    action: 'product.created',
    targetId: id,
    details: { slug, name, rate_limit_per_hour: limit },
  })

  return c.json({ id, slug, name, rate_limit_per_hour: limit }, 201)
})

adminRoutes.patch('/products/:slug', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const product = await db.first<ProductRow>(`SELECT * FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{
    name?: string
    rate_limit_per_hour?: number
    active?: boolean
  }>()

  const name = body.name?.trim() || product.name
  const limit =
    body.rate_limit_per_hour != null
      ? Math.max(1, Math.min(100_000, body.rate_limit_per_hour))
      : product.rate_limit_per_hour
  const active = body.active == null ? product.active : body.active ? 1 : 0

  await db.exec(
    `UPDATE products SET name = ?, rate_limit_per_hour = ?, active = ? WHERE id = ?`,
    [name, limit, active, product.id],
  )

  await logAudit(db, {
    productId: product.id,
    actor: 'admin',
    action: 'product.updated',
    targetId: product.id,
    details: { name, rate_limit_per_hour: limit, active: !!active },
  })

  return c.json({ ok: true })
})

adminRoutes.post('/products/:slug/keys', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const product = await db.first<ProductRow>(`SELECT * FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const body = (await c.req.json<{ name?: string; environment?: 'live' | 'test' }>().catch(() => ({}))) as {
    name?: string
    environment?: 'live' | 'test'
  }
  const environment = body.environment === 'test' ? 'test' : 'live'
  const name = (body.name || `${environment} key`).trim()
  const minted = await mintApiKey(environment)
  const id = newId('key')

  await db.exec(
    `INSERT INTO api_keys (id, product_id, name, key_prefix, key_hash, environment) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, product.id, name, minted.prefix, minted.hash, environment],
  )

  await logAudit(db, {
    productId: product.id,
    actor: 'admin',
    action: 'key.minted',
    targetId: id,
    details: { name, environment, key_prefix: minted.prefix },
  })

  return c.json(
    {
      id,
      name,
      environment,
      key: minted.raw,
      prefix: minted.prefix,
      warning: 'Store this key now — it will not be shown again.',
    },
    201,
  )
})

adminRoutes.post('/products/:slug/keys/:keyId/revoke', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const keyId = c.req.param('keyId')
  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const nowIso = new Date().toISOString()
  const res = await db.exec(
    `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND product_id = ? AND revoked_at IS NULL`,
    [nowIso, keyId, product.id],
  )

  if (!res.changes) return c.json({ error: 'not_found' }, 404)

  await logAudit(db, {
    productId: product.id,
    actor: 'admin',
    action: 'key.revoked',
    targetId: keyId,
    details: { key_id: keyId },
  })

  return c.json({ ok: true })
})

adminRoutes.get('/products/:slug/plans', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const results = await db.query<PlanRow>(
    `SELECT id, slug, name, amount_paise, currency, interval, active, created_at
     FROM plans WHERE product_id = ? ORDER BY amount_paise`,
    [product.id],
  )

  return c.json({
    plans: results.map((p) => ({ ...p, active: !!p.active })),
  })
})

adminRoutes.post('/products/:slug/plans', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json<{
    slug: string
    name: string
    amount_paise: number
    currency?: string
    interval?: string
  }>()

  const planSlug = (body.slug || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(planSlug)) {
    return c.json({ error: 'invalid_plan_slug' }, 400)
  }
  const name = (body.name || planSlug).trim()
  const amount = Number(body.amount_paise)
  if (!Number.isInteger(amount) || amount < 100) {
    return c.json({ error: 'invalid_amount_paise', detail: 'Minimum 100 paise (₹1)' }, 400)
  }
  const currency = (body.currency || 'INR').toUpperCase()
  if (currency !== 'INR') {
    return c.json({ error: 'unsupported_currency', detail: 'Only INR for now' }, 400)
  }
  const interval = body.interval || 'month'
  if (!isValidPlanInterval(interval)) {
    return c.json({ error: 'invalid_interval', detail: 'month | year | one_time' }, 400)
  }

  const id = newId('plan')
  try {
    await db.exec(
      `INSERT INTO plans (id, product_id, slug, name, amount_paise, currency, interval)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, product.id, planSlug, name, amount, currency, interval],
    )
  } catch {
    return c.json({ error: 'plan_slug_taken' }, 409)
  }

  await logAudit(db, {
    productId: product.id,
    actor: 'admin',
    action: 'plan.created',
    targetId: id,
    details: { slug: planSlug, name, amount_paise: amount, currency, interval },
  })

  return c.json(
    { id, slug: planSlug, name, amount_paise: amount, currency, interval, active: true },
    201,
  )
})

adminRoutes.patch('/products/:slug/plans/:planSlug', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const planSlug = c.req.param('planSlug')
  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const plan = await db.first<PlanRow>(
    `SELECT * FROM plans WHERE product_id = ? AND slug = ? LIMIT 1`,
    [product.id, planSlug],
  )
  if (!plan) return c.json({ error: 'plan_not_found' }, 404)

  const body = await c.req.json<{
    name?: string
    amount_paise?: number
    interval?: string
    active?: boolean
  }>()

  const name = body.name?.trim() || plan.name
  let amount = plan.amount_paise
  if (body.amount_paise != null) {
    amount = Number(body.amount_paise)
    if (!Number.isInteger(amount) || amount < 100) {
      return c.json({ error: 'invalid_amount_paise' }, 400)
    }
  }
  let interval = plan.interval
  if (body.interval != null) {
    if (!isValidPlanInterval(body.interval)) {
      return c.json({ error: 'invalid_interval' }, 400)
    }
    interval = body.interval
  }
  const active = body.active == null ? plan.active : body.active ? 1 : 0

  await db.exec(
    `UPDATE plans SET name = ?, amount_paise = ?, interval = ?, active = ? WHERE id = ?`,
    [name, amount, interval, active, plan.id],
  )

  await logAudit(db, {
    productId: product.id,
    actor: 'admin',
    action: 'plan.updated',
    targetId: plan.id,
    details: { slug: planSlug, name, amount_paise: amount, interval, active: !!active },
  })

  return c.json({ ok: true })
})

adminRoutes.get('/products/:slug/payments', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM payments WHERE product_id = ?`,
    [product.id],
  )
  const total = Number(countResult?.total ?? 0)

  const results = await db.query<PaymentRow>(
    `SELECT id, plan_slug, amount_paise, currency, status, razorpay_order_id,
            razorpay_payment_id, confirmed_at, created_at
     FROM payments WHERE product_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [product.id, limit, offset],
  )

  return c.json({
    payments: results,
    pagination: {
      limit,
      offset,
      total,
    },
  })
})

adminRoutes.post('/payments/:id/refund', async (c) => {
  const db = c.get('db')
  const config = c.get('config')
  const id = c.req.param('id')

  const payment = await db.first<PaymentRow>(`SELECT * FROM payments WHERE id = ? LIMIT 1`, [id])
  if (!payment) return c.json({ error: 'not_found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const res = await executeRefund({
    db,
    config,
    payment,
    input: body,
    actor: 'admin',
  })

  if (!res.ok) {
    const { ok: _ok, status, ...errData } = res
    return c.json(errData, status as any)
  }

  return c.json(res.data, 200)
})

adminRoutes.get('/webhooks', async (c) => {
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)

  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const status = c.req.query('status')?.trim()
  const productId = c.req.query('product_id')?.trim()

  const conditions: string[] = []
  const params: unknown[] = []

  if (productId) {
    conditions.push('product_id = ?')
    params.push(productId)
  }
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM webhook_deliveries ${whereClause}`,
    params,
  )
  const total = Number(countResult?.total ?? 0)

  const rows = await db.query<WebhookDeliveryRow>(
    `SELECT id, product_id, event, payload, url, status, attempts, last_attempt_at, next_retry_at, last_error, created_at
     FROM webhook_deliveries ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  const deliveries = rows.map((row) => ({
    ...row,
    payload: row.payload ? tryParseJson(row.payload) : row.payload,
  }))

  return c.json({
    deliveries,
    pagination: {
      limit,
      offset,
      total,
    },
  })
})

adminRoutes.post('/webhooks/:id/redeliver', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const delivery = await db.first<WebhookDeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ? LIMIT 1`,
    [id],
  )
  if (!delivery) return c.json({ error: 'not_found' }, 404)

  const product = await db.first<{ webhook_secret: string | null }>(
    `SELECT webhook_secret FROM products WHERE id = ?`,
    [delivery.product_id],
  )

  const payloadString =
    typeof delivery.payload === 'string'
      ? delivery.payload
      : JSON.stringify(delivery.payload)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-PayDeck-Event': delivery.event,
  }

  if (product?.webhook_secret) {
    headers['X-PayDeck-Signature'] = await hmacSha256Hex(product.webhook_secret, payloadString)
  }

  const attempt = (delivery.attempts || 0) + 1
  const attemptIso = new Date().toISOString()
  const fetchFn = (c.get('config') as any)?.fetchFn || globalThis.fetch

  let ok = false
  let errorMsg: string | null = null

  try {
    const res = await fetchFn(delivery.url, {
      method: 'POST',
      headers,
      body: payloadString,
    })

    if (res.ok) {
      ok = true
      await db.exec(
        `UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, last_attempt_at = ?, last_error = NULL WHERE id = ?`,
        [attempt, attemptIso, id],
      )
    } else {
      ok = false
      errorMsg = `HTTP ${res.status}: ${res.statusText}`
      const BACKOFF_DELAYS = [60, 300, 900, 3600, 21600, 86400]
      const delay = BACKOFF_DELAYS[Math.min(attempt - 1, BACKOFF_DELAYS.length - 1)]
      const nextRetry = new Date(Date.now() + delay * 1000).toISOString()

      await db.exec(
        `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
        [attempt, attemptIso, nextRetry, errorMsg, id],
      )
    }
  } catch (e) {
    ok = false
    errorMsg = (e as Error).message
    const BACKOFF_DELAYS = [60, 300, 900, 3600, 21600, 86400]
    const delay = BACKOFF_DELAYS[Math.min(attempt - 1, BACKOFF_DELAYS.length - 1)]
    const nextRetry = new Date(Date.now() + delay * 1000).toISOString()

    await db.exec(
      `UPDATE webhook_deliveries SET status = 'failed', attempts = ?, last_attempt_at = ?, next_retry_at = ?, last_error = ? WHERE id = ?`,
      [attempt, attemptIso, nextRetry, errorMsg, id],
    )
  }

  await logAudit(db, {
    productId: delivery.product_id,
    actor: 'admin',
    action: 'webhook.redelivered',
    targetId: delivery.id,
    details: { status: ok ? 'delivered' : 'failed', attempts: attempt, error: errorMsg },
  })

  const updated = await db.first<WebhookDeliveryRow>(
    `SELECT * FROM webhook_deliveries WHERE id = ?`,
    [id],
  )

  return c.json({
    ok,
    delivery: updated ? { ...updated, payload: tryParseJson(updated.payload) } : null,
  })
})

adminRoutes.get('/products/:slug/keys', async (c) => {
  const db = c.get('db')
  const slug = c.req.param('slug')
  const product = await db.first<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [slug])
  if (!product) return c.json({ error: 'not_found' }, 404)

  const keys = await db.query<ApiKeyRow>(
    `SELECT id, product_id, name, key_prefix, environment, last_used_at, revoked_at, created_at
     FROM api_keys WHERE product_id = ? ORDER BY created_at DESC`,
    [product.id],
  )
  return c.json({ keys })
})

adminRoutes.get('/keys', async (c) => {
  const db = c.get('db')
  const productId = c.req.query('product_id')?.trim()
  const whereClause = productId ? 'WHERE product_id = ?' : ''
  const params = productId ? [productId] : []
  const keys = await db.query<ApiKeyRow>(
    `SELECT id, product_id, name, key_prefix, environment, last_used_at, revoked_at, created_at
     FROM api_keys ${whereClause} ORDER BY created_at DESC`,
    params,
  )
  return c.json({ keys })
})

adminRoutes.get('/payments', async (c) => {
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)
  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const productId = c.req.query('product_id')?.trim()
  const status = c.req.query('status')?.trim()

  const conditions: string[] = []
  const params: unknown[] = []

  if (productId) {
    conditions.push('product_id = ?')
    params.push(productId)
  }
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM payments ${whereClause}`,
    params,
  )
  const total = Number(countResult?.total ?? 0)

  const payments = await db.query<PaymentRow>(
    `SELECT id, product_id, api_key_id, plan_id, plan_slug, amount_paise, currency, status,
            razorpay_order_id, razorpay_payment_id, customer_id, confirmed_at, created_at
     FROM payments ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  return c.json({
    payments,
    pagination: { limit, offset, total },
  })
})

adminRoutes.get('/customers', async (c) => {
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)
  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)
  const productId = c.req.query('product_id')?.trim()

  const whereClause = productId ? 'WHERE product_id = ?' : ''
  const params = productId ? [productId] : []

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM customers ${whereClause}`,
    params,
  )
  const total = Number(countResult?.total ?? 0)

  const customers = await db.query<CustomerRow>(
    `SELECT id, product_id, email, name, external_user_id, metadata, created_at
     FROM customers ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  return c.json({
    customers: customers.map((row) => ({
      ...row,
      metadata: row.metadata ? tryParseJson(row.metadata) : {},
    })),
    pagination: { limit, offset, total },
  })
})

adminRoutes.post('/customers', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<{
    product_id: string
    email?: string
    name?: string
    external_user_id?: string
    metadata?: Record<string, unknown>
  }>()

  if (!body.product_id) {
    return c.json({ error: 'product_id_required' }, 400)
  }

  const customerId = newId('cust')
  const nowIso = new Date().toISOString()
  const metaJson = body.metadata ? JSON.stringify(body.metadata) : null

  await db.exec(
    `INSERT INTO customers (id, product_id, email, name, external_user_id, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [customerId, body.product_id, body.email || null, body.name || null, body.external_user_id || null, metaJson, nowIso],
  )

  await logAudit(db, {
    productId: body.product_id,
    actor: 'admin',
    action: 'customer.created',
    targetId: customerId,
    details: { email: body.email, name: body.name, external_user_id: body.external_user_id },
  })

  return c.json(
    {
      id: customerId,
      product_id: body.product_id,
      email: body.email || null,
      name: body.name || null,
      external_user_id: body.external_user_id || null,
      metadata: body.metadata || {},
      created_at: nowIso,
    },
    201,
  )
})

adminRoutes.get('/subscriptions', async (c) => {
  const db = c.get('db')
  const limitParam = Number(c.req.query('limit') || 25)
  const offsetParam = Number(c.req.query('offset') || 0)
  const limit = Math.min(100, Math.max(1, isNaN(limitParam) ? 25 : limitParam))
  const offset = Math.max(0, isNaN(offsetParam) ? 0 : offsetParam)

  const productId = c.req.query('product_id')?.trim()
  const customerId = c.req.query('customer_id')?.trim()
  const status = c.req.query('status')?.trim()

  const conditions: string[] = []
  const params: unknown[] = []
  if (productId) {
    conditions.push('product_id = ?')
    params.push(productId)
  }
  if (customerId) {
    conditions.push('customer_id = ?')
    params.push(customerId)
  }
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const countResult = await db.first<{ total: number }>(
    `SELECT COUNT(*) as total FROM subscriptions ${whereClause}`,
    params,
  )
  const total = Number(countResult?.total ?? 0)

  const subscriptions = await db.query<SubscriptionRecord>(
    `SELECT id, product_id, customer_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at
     FROM subscriptions ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )

  return c.json({
    subscriptions,
    pagination: { limit, offset, total },
  })
})

adminRoutes.post('/subscriptions', async (c) => {
  const db = c.get('db')
  const body = await c.req.json<{
    product_id: string
    customer_id: string
    plan_id: string
    period_days?: number
  }>()

  if (!body.product_id || !body.customer_id || !body.plan_id) {
    return c.json({ error: 'missing_required_fields', detail: 'product_id, customer_id, plan_id are required' }, 400)
  }

  const sub = await createSubscription(db, {
    productId: body.product_id,
    customerId: body.customer_id,
    planId: body.plan_id,
    periodDays: body.period_days,
  })

  await logAudit(db, {
    productId: body.product_id,
    actor: 'admin',
    action: 'subscription.created',
    targetId: sub.id,
    details: { customer_id: body.customer_id, plan_id: body.plan_id },
  })

  return c.json(sub, 201)
})

adminRoutes.post('/subscriptions/:id/cancel', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as { immediately?: boolean } | null | undefined
  const sub = await cancelSubscription(db, id, body?.immediately ?? true)
  return c.json({ ok: true, subscription: sub })
})

function tryParseJson(val: string): unknown {
  try {
    return JSON.parse(val)
  } catch {
    return val
  }
}



