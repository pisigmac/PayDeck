import type { Context, Next } from 'hono'
import { parseBearer, sha256Hex, timingSafeEqual } from './crypto'
import type { ApiKeyRow, AppVariables, ProductRow } from './types'

export async function requireProductKey(c: Context<{ Variables: AppVariables }>, next: Next) {
  const token = parseBearer(c.req.header('Authorization'))
  if (!token || (!token.startsWith('pd_') && !token.startsWith('db_') && !token.startsWith('pb_'))) {
    return c.json({ error: 'missing_or_invalid_api_key' }, 401)
  }

  const hash = await sha256Hex(token)
  const prefix = token.slice(0, 14)
  const db = c.get('db')

  const key = await db.first<ApiKeyRow>(
    `SELECT * FROM api_keys WHERE key_prefix = ? AND key_hash = ? AND revoked_at IS NULL LIMIT 1`,
    [prefix, hash],
  )

  if (!key) {
    return c.json({ error: 'invalid_api_key' }, 401)
  }

  const product = await db.first<ProductRow>(
    `SELECT * FROM products WHERE id = ? AND active = 1 LIMIT 1`,
    [key.product_id],
  )

  if (!product) {
    return c.json({ error: 'product_inactive' }, 403)
  }

  const nowIso = new Date().toISOString()
  try {
    c.executionCtx?.waitUntil(
      db.exec(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [nowIso, key.id]),
    )
  } catch {
    // executionCtx not available in this runtime environment
  }

  c.set('auth', { product, key })
  await next()
}

export async function requireAdmin(c: Context<{ Variables: AppVariables }>, next: Next) {
  const config = c.get('config')
  const expected = config.adminToken
  if (!expected) {
    return c.json({ error: 'admin_not_configured' }, 503)
  }
  const provided =
    c.req.header('X-Admin-Token') ||
    parseBearer(c.req.header('Authorization')) ||
    ''
  if (!timingSafeEqual(provided, expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}
