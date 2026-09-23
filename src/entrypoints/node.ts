import { serve } from '@hono/node-server'
import { loadConfig } from '../config/env'
import { SQLiteAdapter } from '../db/sqlite'
import { startWebhookWorker } from '../core/webhook-worker'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import app from '../index'

const config = loadConfig(process.env)
const db = new SQLiteAdapter(config.dbPath)

// Start background webhook delivery processor
startWebhookWorker(db, 30000)

// Auto-run SQL migrations on startup
try {
  const migrationsDir = join(process.cwd(), 'migrations')
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8')
    const statements = sql
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
    for (const stmt of statements) {
      try {
        await db.exec(stmt)
      } catch {}
    }
  }
} catch (e) {
  console.warn('[PayDeck Node Entrypoint] Migration auto-run warning:', e)
}

app.use('*', async (c, next) => {
  c.set('config', config)
  c.set('db', db)
  await next()
})

console.log(`🚀 PayDeck server running at http://${config.host}:${config.port}`)

serve({
  fetch: app.fetch,
  port: config.port,
  hostname: config.host,
})
