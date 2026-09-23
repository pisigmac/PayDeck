import { describe, expect, it } from 'vitest'
import { logAudit } from '../src/core/audit'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('logAudit', () => {
  it('inserts audit log entries with object details', async () => {
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

    await logAudit(db, {
      productId: 'prod_1',
      actor: 'admin',
      action: 'product.created',
      targetId: 'prod_1',
      details: { name: 'FormRelay' },
    })

    const logs = await db.query<{
      id: string
      product_id: string
      actor: string
      action: string
      target_id: string
      details: string
      created_at: string
    }>(`SELECT * FROM audit_logs`)

    expect(logs.length).toBe(1)
    expect(logs[0]?.id).toMatch(/^audit_/)
    expect(logs[0]?.product_id).toBe('prod_1')
    expect(logs[0]?.actor).toBe('admin')
    expect(logs[0]?.action).toBe('product.created')
    expect(logs[0]?.target_id).toBe('prod_1')
    expect(JSON.parse(logs[0]!.details)).toEqual({ name: 'FormRelay' })
    expect(logs[0]?.created_at).toBeDefined()

    await db.close?.()
  })

  it('inserts audit log entries with null details and null productId', async () => {
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

    await logAudit(db, {
      actor: 'system',
      action: 'key.revoked',
      targetId: 'key_123',
    })

    const logs = await db.query<{
      id: string
      product_id: string | null
      actor: string
      action: string
      target_id: string
      details: string | null
    }>(`SELECT * FROM audit_logs`)

    expect(logs.length).toBe(1)
    expect(logs[0]?.product_id).toBeNull()
    expect(logs[0]?.details).toBeNull()
    expect(logs[0]?.actor).toBe('system')

    await db.close?.()
  })
})
