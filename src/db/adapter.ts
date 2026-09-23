export interface DatabaseAdapter {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  first<T>(sql: string, params?: unknown[]): Promise<T | null>
  exec(sql: string, params?: unknown[]): Promise<{ changes: number }>
  transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T>
  close?(): Promise<void>
}

