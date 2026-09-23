import type { DatabaseAdapter } from './db/adapter'
import type { ProductRow } from './types'

export function hourBucket(d = new Date()): string {
  return d.toISOString().slice(0, 13) // YYYY-MM-DDTHH
}

export function secondsUntilNextHour(d = new Date()): number {
  const nextHour = new Date(d)
  nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0)
  return Math.ceil((nextHour.getTime() - d.getTime()) / 1000)
}

export async function assertWithinRateLimit(
  db: DatabaseAdapter,
  product: ProductRow,
): Promise<
  | { ok: true; limit: number; used: number; remaining: number; resetSeconds: number }
  | { ok: false; limit: number; used: number; remaining: number; resetSeconds: number }
> {
  const bucket = hourBucket()
  const resetSeconds = secondsUntilNextHour()
  const row = await db.first<{ count: number }>(
    `SELECT count FROM rate_buckets WHERE product_id = ? AND hour_bucket = ?`,
    [product.id, bucket],
  )

  const used = row?.count ?? 0
  const limit = product.rate_limit_per_hour
  const remaining = Math.max(0, limit - used - 1)

  if (used >= limit) {
    return { ok: false, limit, used, remaining: 0, resetSeconds }
  }

  await db.exec(
    `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES (?, ?, 1)
     ON CONFLICT(product_id, hour_bucket) DO UPDATE SET count = count + 1`,
    [product.id, bucket],
  )

  return { ok: true, limit, used: used + 1, remaining, resetSeconds }
}

export function isValidPlanInterval(interval: string): boolean {
  return interval === 'month' || interval === 'year' || interval === 'one_time'
}
