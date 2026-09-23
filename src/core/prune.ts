import type { DatabaseAdapter } from '../db/adapter'

/**
 * Purges rate_buckets older than retentionHours (default: 168 hours / 7 days).
 * Returns the number of deleted rows.
 */
export async function pruneOldBuckets(
  db: DatabaseAdapter,
  retentionHours = 168,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionHours * 3600 * 1000)
    .toISOString()
    .slice(0, 13)
  const res = await db.exec(`DELETE FROM rate_buckets WHERE hour_bucket < ?`, [
    cutoff,
  ])
  return res.changes
}

/**
 * Purges audit_logs older than retentionDays (default: 90 days).
 * Returns the number of deleted rows.
 */
export async function pruneOldAuditLogs(
  db: DatabaseAdapter,
  retentionDays = 90,
): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString()
  const res = await db.exec(`DELETE FROM audit_logs WHERE created_at < ?`, [
    cutoff,
  ])
  return res.changes
}
