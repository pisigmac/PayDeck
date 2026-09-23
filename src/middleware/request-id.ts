import type { Context, Next } from 'hono'
import { newId } from '../crypto'
import type { AppVariables } from '../types'

export async function requestIdMiddleware(c: Context<{ Variables: AppVariables }>, next: Next) {
  const reqId = c.req.header('X-Request-Id') || newId('req')
  c.set('requestId', reqId)
  c.header('X-Request-Id', reqId)
  await next()
}
