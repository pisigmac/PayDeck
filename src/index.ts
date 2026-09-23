import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { errorEnvelope } from './core/validation'
import { requestIdMiddleware } from './middleware/request-id'
import { securityHeadersMiddleware } from './middleware/security'
import { razorpayConfigured } from './razorpay'
import { adminRoutes } from './routes/admin'
import { billingRoutes } from './routes/billing'
import { cloudRoutes } from './routes/cloud'
import { webhookRoutes } from './routes/webhooks'
import type { AppVariables } from './types'

import { loadConfig } from './config/env'
import { SQLiteAdapter } from './db/sqlite'

let globalDefaultDb: SQLiteAdapter | null = null

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', async (c, next) => {
  if (!c.get('config')) {
    c.set('config', loadConfig(process.env))
  }
  if (!c.get('db')) {
    if (!globalDefaultDb) {
      globalDefaultDb = new SQLiteAdapter(c.get('config').dbPath)
    }
    c.set('db', globalDefaultDb)
  }
  await next()
})

app.use('*', requestIdMiddleware)
app.use('*', securityHeadersMiddleware)
app.use('*', async (c, next) => {
  const allowedOrigins = c.get('config')?.allowedOrigins || '*'
  const corsHandler = cors({
    origin: allowedOrigins.includes(',')
      ? allowedOrigins.split(',').map((o) => o.trim())
      : allowedOrigins,
  })
  return corsHandler(c, next)
})

app.get('/health', async (c) => {
  const db = c.get('db')
  const config = c.get('config')
  let dbOk = false
  try {
    if (db) {
      await db.first(`SELECT 1`)
      dbOk = true
    }
  } catch {
    dbOk = false
  }
  const razorpay = razorpayConfigured({
    RAZORPAY_KEY_ID: config?.razorpayKeyId,
    RAZORPAY_KEY_SECRET: config?.razorpayKeySecret,
  })
  const status = dbOk ? 'ok' : 'degraded'
  return c.json(
    {
      status,
      service: 'paydeck',
      db: dbOk,
      razorpay_configured: razorpay,
      allow_dev_charge: config?.allowDevCharge ?? false,
      webhook_secret_configured: Boolean(config?.razorpayWebhookSecret),
    },
    dbOk ? 200 : 503,
  )
})

app.get('/v1/openapi.json', (c) =>
  c.json({
    openapi: '3.0.3',
    info: {
      title: 'PayDeck API',
      version: '1.0.0',
      description: 'Generic, multi-runtime Razorpay billing microservice for PayDeck products',
    },
    paths: {
      '/health': { get: { summary: 'Health check' } },
      '/v1/plans': {
        get: {
          summary: 'List active plans for authenticated product',
          security: [{ bearerAuth: [] }],
        },
      },
      '/v1/orders': {
        post: {
          summary: 'Create Razorpay order for a plan or ad-hoc amount',
          security: [{ bearerAuth: [] }],
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    plan: { type: 'string' },
                    amount_paise: { type: 'integer', minimum: 100 },
                    currency: { type: 'string', default: 'INR' },
                    receipt: { type: 'string', maxLength: 40 },
                    notes: { type: 'object' },
                    metadata: { type: 'object' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/verify': {
        post: {
          summary: 'Verify payment signature and mark paid',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['razorpay_order_id', 'razorpay_payment_id', 'razorpay_signature'],
                  properties: {
                    razorpay_order_id: { type: 'string' },
                    razorpay_payment_id: { type: 'string' },
                    razorpay_signature: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      '/v1/payments': {
        get: {
          summary: 'List payments with pagination',
          security: [{ bearerAuth: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
        },
      },
      '/v1/payments/{id}': {
        get: {
          summary: 'Get single payment by ID',
          security: [{ bearerAuth: [] }],
        },
      },
      '/v1/payments/{id}/refund': {
        post: {
          summary: 'Refund payment (full or partial)',
          security: [{ bearerAuth: [] }],
        },
      },
      '/v1/admin/payments/{id}/refund': {
        post: {
          summary: 'Admin refund payment (full or partial)',
          security: [{ adminToken: [] }],
        },
      },
      '/v1/webhooks/razorpay': {
        post: {
          summary: 'Razorpay webhook receiver',
          parameters: [{ name: 'X-Razorpay-Signature', in: 'header', schema: { type: 'string' } }],
        },
      },
      '/v1/admin/products': {
        get: { summary: 'List all products', security: [{ adminToken: [] }] },
        post: { summary: 'Create new product', security: [{ adminToken: [] }] },
      },
      '/v1/admin/audit-logs': {
        get: {
          summary: 'List admin audit logs with pagination & filters',
          security: [{ adminToken: [] }],
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'product_id', in: 'query', schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
          ],
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        adminToken: { type: 'apiKey', in: 'header', name: 'X-Admin-Token' },
      },
    },
  }),
)

// Mount sub-routes
app.route('/v1/webhooks', webhookRoutes)
app.route('/v1/admin', adminRoutes)
app.route('/v1/cloud', cloudRoutes)
app.route('/v1', billingRoutes)

app.get('/robots.txt', (c) => {
  try {
    const robotsPath = join(process.cwd(), 'public', 'robots.txt')
    if (existsSync(robotsPath)) {
      return c.text(readFileSync(robotsPath, 'utf-8'), 200, { 'Content-Type': 'text/plain' })
    }
  } catch {}
  return c.text("User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: https://paydeck.dev/sitemap.xml", 200, { 'Content-Type': 'text/plain' })
})

app.get('/sitemap.xml', (c) => {
  try {
    const sitemapPath = join(process.cwd(), 'public', 'sitemap.xml')
    if (existsSync(sitemapPath)) {
      return c.text(readFileSync(sitemapPath, 'utf-8'), 200, { 'Content-Type': 'application/xml' })
    }
  } catch {}
  return c.text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemap.org/schemas/sitemap/0.9"><url><loc>https://paydeck.dev/</loc></url></urlset>', 200, { 'Content-Type': 'application/xml' })
})

const serveLandingPage = (c: any) => {
  try {
    const indexPath = join(process.cwd(), 'public', 'index.html')
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath, 'utf-8')
      return c.html(html)
    }
  } catch {}
  return c.html('<!DOCTYPE html><html><head><title>PayDeck</title></head><body>PayDeck Billing Spine</body></html>')
}

app.get('/', serveLandingPage)
app.get('/index.html', serveLandingPage)

const serveAdminDashboard = (c: any) => {
  try {
    const adminPath = join(process.cwd(), 'public', 'admin', 'index.html')
    if (existsSync(adminPath)) {
      const html = readFileSync(adminPath, 'utf-8')
      return c.html(html)
    }
  } catch {}
  return c.html('<!DOCTYPE html><html><head><title>PayDeck Admin</title></head><body>PayDeck Web Admin Dashboard</body></html>')
}

app.get('/admin', serveAdminDashboard)
app.get('/admin/', serveAdminDashboard)
app.get('/admin/index.html', serveAdminDashboard)
app.get('/admin/*', serveAdminDashboard)
app.get('/public/admin/*', serveAdminDashboard)

app.all('*', async (c) => {
  const reqId = c.get('requestId') || 'req_not_found'
  return c.json(errorEnvelope(reqId, 'not_found', 'NOT_FOUND', 'Endpoint not found'), 404)
})

export default app
