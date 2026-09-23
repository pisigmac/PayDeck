import { describe, expect, it } from 'vitest'
import { SQLiteAdapter } from '../src/db/sqlite'
import { D1Adapter } from '../src/db/d1'

describe('DatabaseAdapter Transactions', () => {
  describe('SQLiteAdapter', () => {
    it('commits transaction on success and returns value', async () => {
      const db = new SQLiteAdapter(':memory:')
      await db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);`)

      const result = await db.transaction(async (tx) => {
        await tx.exec(`INSERT INTO items (id, val) VALUES (?, ?)`, ['1', 'alpha'])
        await tx.exec(`INSERT INTO items (id, val) VALUES (?, ?)`, ['2', 'beta'])
        return 'success'
      })

      expect(result).toBe('success')

      const rows = await db.query<{ id: string; val: string }>(`SELECT * FROM items ORDER BY id ASC`)
      expect(rows).toEqual([
        { id: '1', val: 'alpha' },
        { id: '2', val: 'beta' },
      ])

      await db.close()
    })

    it('rolls back transaction on error and rethrows', async () => {
      const db = new SQLiteAdapter(':memory:')
      await db.exec(`CREATE TABLE items (id TEXT PRIMARY KEY, val TEXT);`)

      await expect(
        db.transaction(async (tx) => {
          await tx.exec(`INSERT INTO items (id, val) VALUES (?, ?)`, ['1', 'alpha'])
          throw new Error('Transaction failed')
        }),
      ).rejects.toThrow('Transaction failed')

      const rows = await db.query<{ id: string; val: string }>(`SELECT * FROM items`)
      expect(rows).toEqual([])

      await db.close()
    })
  })

  describe('D1Adapter', () => {
    it('executes BEGIN, operations, and COMMIT on success', async () => {
      const executedSqls: string[] = []
      const mockD1 = {
        prepare: (sql: string) => ({
          bind: (..._params: unknown[]) => ({
            run: async () => {
              executedSqls.push(sql)
              return { meta: { changes: 1 } }
            },
            all: async () => {
              executedSqls.push(sql)
              return { results: [] }
            },
            first: async () => {
              executedSqls.push(sql)
              return null
            },
          }),
        }),
      } as unknown as D1Database

      const db = new D1Adapter(mockD1)
      const res = await db.transaction(async (tx) => {
        await tx.exec('INSERT INTO test VALUES (?)', [1])
        return 42
      })

      expect(res).toBe(42)
      expect(executedSqls).toEqual(['BEGIN', 'INSERT INTO test VALUES (?)', 'COMMIT'])
    })

    it('executes BEGIN, operations, and ROLLBACK on error', async () => {
      const executedSqls: string[] = []
      const mockD1 = {
        prepare: (sql: string) => ({
          bind: (..._params: unknown[]) => ({
            run: async () => {
              executedSqls.push(sql)
              return { meta: { changes: 1 } }
            },
            all: async () => {
              executedSqls.push(sql)
              return { results: [] }
            },
            first: async () => {
              executedSqls.push(sql)
              return null
            },
          }),
        }),
      } as unknown as D1Database

      const db = new D1Adapter(mockD1)

      await expect(
        db.transaction(async (tx) => {
          await tx.exec('INSERT INTO test VALUES (?)', [1])
          throw new Error('D1 error')
        }),
      ).rejects.toThrow('D1 error')

      expect(executedSqls).toEqual(['BEGIN', 'INSERT INTO test VALUES (?)', 'ROLLBACK'])
    })
  })
})
