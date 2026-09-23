import { Hono } from 'hono'
import { z } from 'zod'
import { errorEnvelope, formatZodError } from '../core/validation'
import { newId, parseBearer, timingSafeEqual } from '../crypto'
import {
  authenticateUser,
  createTenantUser,
  ensureCloudTables,
  getCurrentMonthBucket,
  TIER_LIMITS,
} from '../core/cloud-tenant'
import type { DatabaseAdapter } from '../db/adapter'
import type { AppVariables, CloudUserRow, OrganizationRow, OrgUsageMeterRow } from '../types'

export const cloudRoutes = new Hono<{ Variables: AppVariables }>()

const CloudSignupSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  name: z.string().trim().min(1, 'Name is required'),
  org_name: z.string().trim().min(1, 'Organization name is required').optional(),
  orgName: z.string().trim().min(1, 'Organization name is required').optional(),
})

const CloudLoginSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
})

const CloudUpgradeSchema = z.object({
  tier: z.enum(['starter', 'pro', 'business', 'free']),
  org_id: z.string().optional(),
})

async function authenticateCloudUser(c: any) {
  const db: DatabaseAdapter = c.get('db')
  const config = c.get('config')
  await ensureCloudTables(db)

  const adminHeader = c.req.header('X-Admin-Token')
  const authHeader = c.req.header('Authorization')
  const bearerToken = parseBearer(authHeader)

  if (adminHeader && config?.adminToken && timingSafeEqual(adminHeader, config.adminToken)) {
    let user = await db.first<CloudUserRow>(`SELECT * FROM cloud_users ORDER BY created_at ASC LIMIT 1`)
    let org = await db.first<OrganizationRow>(`SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1`)

    if (!user || !org) {
      const res = await createTenantUser(db, {
        email: 'admin@paydeck.dev',
        password: 'admin123',
        name: 'Admin User',
        orgName: 'Default Admin Org',
      })
      user = res.user
      org = res.org
    }

    return { user, organization: org }
  }

  if (bearerToken) {
    let userId = bearerToken
    if (bearerToken.startsWith('pd_cloud_')) {
      userId = bearerToken.replace('pd_cloud_', '')
    }

    const user = await db.first<CloudUserRow>(`SELECT * FROM cloud_users WHERE id = ? LIMIT 1`, [userId])
    if (user) {
      const org = await db.first<OrganizationRow>(`SELECT * FROM organizations WHERE owner_id = ? LIMIT 1`, [user.id])
      if (org) {
        return { user, organization: org }
      }
    }
  }

  return null
}

// POST /v1/cloud/signup
cloudRoutes.post('/signup', async (c) => {
  const reqId = c.get('requestId') || newId('req')
  const db: DatabaseAdapter = c.get('db')
  await ensureCloudTables(db)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(errorEnvelope(reqId, 'invalid_json', 'INVALID_JSON', 'Invalid JSON body'), 400)
  }

  const parsed = CloudSignupSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      errorEnvelope(reqId, 'validation_error', 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error)),
      400,
    )
  }

  const { email, password, name, org_name, orgName } = parsed.data
  const finalOrgName = (org_name || orgName || 'My Organization').trim()

  try {
    const { user, org } = await createTenantUser(db, {
      email,
      password,
      name,
      orgName: finalOrgName,
    })

    const token = `pd_cloud_${user.id}`
    return c.json({ token, user, organization: org }, 201)
  } catch (err) {
    return c.json(
      errorEnvelope(reqId, 'email_exists', 'EMAIL_EXISTS', (err as Error).message),
      400,
    )
  }
})

// POST /v1/cloud/login
cloudRoutes.post('/login', async (c) => {
  const reqId = c.get('requestId') || newId('req')
  const db: DatabaseAdapter = c.get('db')
  await ensureCloudTables(db)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(errorEnvelope(reqId, 'invalid_json', 'INVALID_JSON', 'Invalid JSON body'), 400)
  }

  const parsed = CloudLoginSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      errorEnvelope(reqId, 'validation_error', 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error)),
      400,
    )
  }

  const { email, password } = parsed.data
  const authRes = await authenticateUser(db, email, password)
  if (!authRes) {
    return c.json(errorEnvelope(reqId, 'invalid_credentials', 'INVALID_CREDENTIALS', 'Invalid email or password'), 401)
  }

  const { user, org } = authRes
  const token = `pd_cloud_${user.id}`

  return c.json({ token, user, organization: org }, 200)
})

// GET /v1/cloud/me
cloudRoutes.get('/me', async (c) => {
  const reqId = c.get('requestId') || newId('req')
  const db: DatabaseAdapter = c.get('db')
  const auth = await authenticateCloudUser(c)

  if (!auth) {
    return c.json(errorEnvelope(reqId, 'unauthorized', 'UNAUTHORIZED', 'Authentication required'), 401)
  }

  const { user, organization } = auth
  const monthBucket = getCurrentMonthBucket()

  const meterRow = await db.first<OrgUsageMeterRow>(
    `SELECT order_count FROM org_usage_meters WHERE org_id = ? AND month_bucket = ? LIMIT 1`,
    [organization.id, monthBucket],
  )
  const orderCount = Number(meterRow?.order_count ?? 0)
  const limitValue = TIER_LIMITS[organization.tier] ?? TIER_LIMITS.free

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      created_at: user.created_at,
    },
    organization: {
      id: organization.id,
      slug: organization.slug,
      name: organization.name,
      tier: organization.tier,
      owner_id: organization.owner_id,
      created_at: organization.created_at,
    },
    usage: {
      month: monthBucket,
      order_count: orderCount,
    },
    tier_limits: {
      tier: organization.tier,
      orders_per_month: limitValue,
    },
  })
})

// POST /v1/cloud/org/upgrade
cloudRoutes.post('/org/upgrade', async (c) => {
  const reqId = c.get('requestId') || newId('req')
  const db: DatabaseAdapter = c.get('db')
  const auth = await authenticateCloudUser(c)

  if (!auth) {
    return c.json(errorEnvelope(reqId, 'unauthorized', 'UNAUTHORIZED', 'Authentication required'), 401)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json(errorEnvelope(reqId, 'invalid_json', 'INVALID_JSON', 'Invalid JSON body'), 400)
  }

  const parsed = CloudUpgradeSchema.safeParse(body)
  if (!parsed.success) {
    return c.json(
      errorEnvelope(reqId, 'validation_error', 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error)),
      400,
    )
  }

  const { tier } = parsed.data
  const targetOrgId = parsed.data.org_id || auth.organization.id

  await db.exec(`UPDATE organizations SET tier = ? WHERE id = ?`, [tier, targetOrgId])

  const updatedOrg = await db.first<OrganizationRow>(`SELECT * FROM organizations WHERE id = ? LIMIT 1`, [targetOrgId])

  return c.json({
    organization: updatedOrg,
  })
})
