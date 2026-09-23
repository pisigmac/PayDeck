import { loadConfig } from '../config/env'
import { SQLiteAdapter } from '../db/sqlite'
import app from '../index'

const config = loadConfig(process.env)
const db = new SQLiteAdapter(config.dbPath)

app.use('*', async (c, next) => {
  c.set('config', config)
  c.set('db', db)
  await next()
})

console.log(`🚀 PayDeck (Bun) running on http://${config.host}:${config.port}`)

export default {
  port: config.port,
  hostname: config.host,
  fetch: app.fetch,
}
