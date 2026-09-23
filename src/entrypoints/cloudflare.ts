import { loadConfig } from '../config/env'
import { D1Adapter } from '../db/d1'
import app from '../index'

export default {
  async fetch(req: Request, env: Record<string, unknown>, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(env as Record<string, string>)
    const d1 = env.DB as D1Database
    const db = new D1Adapter(d1)

    app.use('*', async (c, next) => {
      c.set('config', config)
      c.set('db', db)
      await next()
    })

    return app.fetch(req, env, ctx)
  },
}
