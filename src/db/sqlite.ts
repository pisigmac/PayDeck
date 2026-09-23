import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseAdapter } from './adapter'

export class SQLiteAdapter implements DatabaseAdapter {
  private db: InstanceType<typeof Database>

  constructor(filename = ':memory:') {
    if (filename !== ':memory:') {
      const dir = path.dirname(filename)
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new Database(filename)
    this.db.pragma('journal_mode = WAL')
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as T[]
  }

  async first<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const stmt = this.db.prepare(sql)
    const row = stmt.get(...params) as T | undefined
    return row ?? null
  }

  async exec(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    if (params.length === 0) {
      this.db.exec(sql)
      return { changes: 0 }
    }
    const stmt = this.db.prepare(sql)
    const info = stmt.run(...params)
    return { changes: Number(info.changes) }
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    await this.exec('BEGIN IMMEDIATE')
    try {
      const result = await fn(this)
      await this.exec('COMMIT')
      return result
    } catch (err) {
      await this.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    this.db.close()
  }
}
