import type { DatabaseAdapter } from './adapter'

export class PostgresAdapter implements DatabaseAdapter {
  constructor(private client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params)
    return (res.rows as T[]) || []
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params)
    return rows[0] ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.client.query(sql, params)
    return { changes: res.rowCount || 0 }
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    await this.exec('BEGIN')
    try {
      const result = await fn(this)
      await this.exec('COMMIT')
      return result
    } catch (err) {
      await this.exec('ROLLBACK')
      throw err
    }
  }
}
