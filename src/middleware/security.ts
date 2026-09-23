import type { Context, Next } from 'hono'
import type { AppVariables } from '../types'

export async function securityHeadersMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  await next()
}
