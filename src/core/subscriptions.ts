import { newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

export interface CreateSubscriptionOpts {
  productId: string
  customerId: string
  planId: string
  periodDays?: number
}

export interface SubscriptionRecord {
  id: string
  product_id: string
  customer_id: string
  plan_id: string
  status: string
  current_period_start: string
  current_period_end: string
  cancel_at_period_end: number
  created_at: string
}

export async function createSubscription(
  db: DatabaseAdapter,
  opts: CreateSubscriptionOpts,
) {
  const id = newId('sub')
  const now = new Date()
  const startIso = now.toISOString()
  const periodDays = opts.periodDays || 30
  const endIso = new Date(now.getTime() + periodDays * 86400 * 1000).toISOString()

  await db.exec(
    `INSERT INTO subscriptions (id, product_id, customer_id, plan_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?)`,
    [id, opts.productId, opts.customerId, opts.planId, startIso, endIso, startIso],
  )

  return {
    id,
    product_id: opts.productId,
    customer_id: opts.customerId,
    plan_id: opts.planId,
    productId: opts.productId,
    customerId: opts.customerId,
    planId: opts.planId,
    status: 'active',
    current_period_start: startIso,
    current_period_end: endIso,
    cancel_at_period_end: 0,
    created_at: startIso,
  }
}

export async function cancelSubscription(
  db: DatabaseAdapter,
  subscriptionId: string,
  immediately = true,
) {
  if (immediately) {
    await db.exec(`UPDATE subscriptions SET status = 'canceled' WHERE id = ?`, [subscriptionId])
  } else {
    await db.exec(`UPDATE subscriptions SET cancel_at_period_end = 1 WHERE id = ?`, [subscriptionId])
  }

  const row = await db.first<SubscriptionRecord>(
    `SELECT * FROM subscriptions WHERE id = ?`,
    [subscriptionId],
  )

  return row || { id: subscriptionId, status: immediately ? 'canceled' : 'active' }
}
