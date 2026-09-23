import { describe, expect, it } from 'vitest'
import { SQLiteAdapter } from '../src/db/sqlite'

describe('SQLiteAdapter (in-memory)', () => {
  it('executes schema and queries rows', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL
      );
    `)

    await db.exec(`INSERT INTO products (id, slug, name) VALUES (?, ?, ?)`, ['prod_1', 'formrelay', 'Formrelay'])

    const rows = await db.query<{ id: string; slug: string; name: string }>(
      `SELECT * FROM products WHERE slug = ?`,
      ['formrelay'],
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.name).toBe('Formrelay')

    const single = await db.first<{ id: string; slug: string }>(
      `SELECT id, slug FROM products WHERE id = ?`,
      ['prod_1'],
    )
    expect(single?.slug).toBe('formrelay')
    await db.close?.()
  })
})
