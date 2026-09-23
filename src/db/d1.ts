import type { DatabaseAdapter } from './adapter'

export class D1Adapter implements DatabaseAdapter {
  constructor(private d1: D1Database) {}

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { results } = await this.d1.prepare(sql).bind(...params).all<T>()
    return results || []
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const res = await this.d1.prepare(sql).bind(...params).first<T>()
    return res ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const res = await this.d1.prepare(sql).bind(...params).run()
    return { changes: res.meta?.changes ?? 0 }
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
