import type { Context, Next } from 'hono'
import type { DatabaseAdapter } from '../db/adapter'
import type { AppVariables } from '../types'

export const TIER_LIMITS: Record<string, number> = {
  free: 100,
  starter: 5000,
  pro: 50000,
  business: Infinity,
}

export function getMonthBucket(date: Date = new Date()): string {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${yyyy}-${mm}`
}

export async function checkOrgTierLimit(
  db: DatabaseAdapter,
  orgId: string,
  date: Date = new Date(),
): Promise<{ allowed: boolean; limit: number; used: number; tier: string }> {
  const monthBucket = getMonthBucket(date)

  let tier = 'free'
  try {
    const org = await db.first<{ tier: string }>(
      `SELECT tier FROM organizations WHERE id = ? LIMIT 1`,
      [orgId],
    )
    if (org?.tier) {
      tier = org.tier.toLowerCase()
    }
  } catch {
    // Default to free if table does not exist
  }

  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free

  if (limit === Infinity) {
    return { allowed: true, limit: Infinity, used: 0, tier }
  }

  let used = 0
  try {
    const meter = await db.first<{ order_count: number }>(
      `SELECT order_count FROM org_usage_meters WHERE org_id = ? AND month_bucket = ? LIMIT 1`,
      [orgId, monthBucket],
    )
    if (meter) {
      used = Number(meter.order_count ?? 0)
    }
  } catch {
    // Default to 0
  }

  return {
    allowed: used < limit,
    limit,
    used,
    tier,
  }
}

export async function incrementOrgUsage(
  db: DatabaseAdapter,
  orgId: string,
  date: Date = new Date(),
): Promise<void> {
  const monthBucket = getMonthBucket(date)
  try {
    await db.exec(
      `INSERT INTO org_usage_meters (org_id, month_bucket, order_count)
       VALUES (?, ?, 1)
       ON CONFLICT(org_id, month_bucket) DO UPDATE SET order_count = order_count + 1`,
      [orgId, monthBucket],
    )
  } catch {
    try {
      const existing = await db.first<{ order_count: number }>(
        `SELECT order_count FROM org_usage_meters WHERE org_id = ? AND month_bucket = ? LIMIT 1`,
        [orgId, monthBucket],
      )
      if (existing) {
        await db.exec(
          `UPDATE org_usage_meters SET order_count = order_count + 1 WHERE org_id = ? AND month_bucket = ?`,
          [orgId, monthBucket],
        )
      } else {
        await db.exec(
          `INSERT INTO org_usage_meters (org_id, month_bucket, order_count) VALUES (?, ?, 1)`,
          [orgId, monthBucket],
        )
      }
    } catch {
      // Ignored if table doesn't exist
    }
  }
}

export async function tierLimitsMiddleware(
  c: Context<{ Variables: AppVariables }>,
  next: Next,
) {
  const auth = c.get('auth')
  const db = c.get('db')

  if (auth?.product?.org_id) {
    const check = await checkOrgTierLimit(db, auth.product.org_id)
    if (!check.allowed) {
      return c.json(
        {
          error: 'tier_limit_exceeded',
          message:
            'Monthly order volume tier limit reached. Please upgrade your PayDeck Cloud plan.',
        },
        429,
      )
    }
  }

  await next()
}
