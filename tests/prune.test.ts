import { describe, expect, it } from 'vitest'
import { pruneOldAuditLogs, pruneOldBuckets } from '../src/core/prune'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('pruneOldBuckets', () => {
  it('purges rate_buckets older than retentionHours and returns deleted count', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE rate_buckets (
        product_id TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, hour_bucket)
      );
    `)

    const nowIso = new Date().toISOString()
    const currentHour = nowIso.slice(0, 13)

    // Old buckets (from year 2020)
    await db.exec(
      `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES ('prod_1', '2020-01-01T00', 10)`,
    )
    await db.exec(
      `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES ('prod_1', '2020-01-01T01', 5)`,
    )

    // Recent bucket
    await db.exec(
      `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES ('prod_1', ?, 2)`,
      [currentHour],
    )

    // Default retentionHours = 168 (7 days)
    const deletedCount = await pruneOldBuckets(db)
    expect(deletedCount).toBe(2)

    const remaining = await db.query<{ product_id: string; hour_bucket: string; count: number }>(
      `SELECT * FROM rate_buckets`,
    )
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.hour_bucket).toBe(currentHour)

    await db.close?.()
  })

  it('respects custom retentionHours parameter', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE rate_buckets (
        product_id TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, hour_bucket)
      );
    `)

    const now = Date.now()
    const fiveHoursAgoHour = new Date(now - 5 * 3600 * 1000).toISOString().slice(0, 13)
    const fifteenHoursAgoHour = new Date(now - 15 * 3600 * 1000).toISOString().slice(0, 13)

    await db.exec(
      `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES ('prod_1', ?, 1)`,
      [fifteenHoursAgoHour],
    )
    await db.exec(
      `INSERT INTO rate_buckets (product_id, hour_bucket, count) VALUES ('prod_1', ?, 1)`,
      [fiveHoursAgoHour],
    )

    // Prune with retentionHours = 10 (15 hours ago should be deleted, 5 hours ago retained)
    const deletedCount = await pruneOldBuckets(db, 10)
    expect(deletedCount).toBe(1)

    const remaining = await db.query<{ hour_bucket: string }>(`SELECT hour_bucket FROM rate_buckets`)
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.hour_bucket).toBe(fiveHoursAgoHour)

    await db.close?.()
  })
})

describe('pruneOldAuditLogs', () => {
  it('purges audit_logs older than retentionDays and returns deleted count', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `)

    const now = Date.now()
    const hundredDaysAgo = new Date(now - 100 * 86400 * 1000).toISOString()
    const tenDaysAgo = new Date(now - 10 * 86400 * 1000).toISOString()
    const currentIso = new Date(now).toISOString()

    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('audit_old_1', 'admin', 'action.old', 't1', '2020-01-01T00:00:00.000Z')`,
    )
    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('audit_old_2', 'system', 'action.old2', 't2', ?)`,
      [hundredDaysAgo],
    )
    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('audit_new_1', 'user', 'action.new', 't3', ?)`,
      [tenDaysAgo],
    )
    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('audit_recent', 'user', 'action.recent', 't4', ?)`,
      [currentIso],
    )

    // Default retentionDays = 90
    const deletedCount = await pruneOldAuditLogs(db)
    expect(deletedCount).toBe(2)

    const remaining = await db.query<{ id: string }>(`SELECT id FROM audit_logs ORDER BY id`)
    expect(remaining.length).toBe(2)
    expect(remaining.map((r) => r.id)).toEqual(['audit_new_1', 'audit_recent'])

    await db.close?.()
  })

  it('respects custom retentionDays parameter', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        product_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `)

    const now = Date.now()
    const tenDaysAgo = new Date(now - 10 * 86400 * 1000).toISOString()
    const twoDaysAgo = new Date(now - 2 * 86400 * 1000).toISOString()

    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('log_10d', 'admin', 'test', 't1', ?)`,
      [tenDaysAgo],
    )
    await db.exec(
      `INSERT INTO audit_logs (id, actor, action, target_id, created_at) VALUES ('log_2d', 'admin', 'test', 't2', ?)`,
      [twoDaysAgo],
    )

    // Custom retentionDays = 5 (10 days ago should be deleted, 2 days ago retained)
    const deletedCount = await pruneOldAuditLogs(db, 5)
    expect(deletedCount).toBe(1)

    const remaining = await db.query<{ id: string }>(`SELECT id FROM audit_logs`)
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.id).toBe('log_2d')

    await db.close?.()
  })
})
