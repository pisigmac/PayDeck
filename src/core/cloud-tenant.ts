import type { DatabaseAdapter } from '../db/adapter'
import type { CloudUserRow, OrganizationRow, OrgUsageMeterRow } from '../types'
import { newId, sha256Hex, timingSafeEqual } from '../crypto'

export async function hashPassword(password: string, salt: string): Promise<string> {
  return sha256Hex(`${salt}:${password}`)
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const computed = await hashPassword(password, salt)
  return timingSafeEqual(computed, hash)
}

export async function ensureCloudTables(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS org_usage_meters (
      org_id TEXT NOT NULL,
      month_bucket TEXT NOT NULL,
      order_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, month_bucket)
    );
  `)
}

export function getCurrentMonthBucket(): string {
  const now = new Date()
  const year = now.getUTCFullYear()
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

export interface CreateTenantUserOpts {
  email: string
  password: string
  name: string
  orgName?: string
  orgSlug?: string
}

export async function createTenantUser(
  db: DatabaseAdapter,
  opts: CreateTenantUserOpts,
): Promise<{ user: CloudUserRow; org: OrganizationRow }> {
  const normalizedEmail = opts.email.toLowerCase().trim()

  const existingUser = await db.first<CloudUserRow>(
    `SELECT * FROM cloud_users WHERE email = ?`,
    [normalizedEmail],
  )
  if (existingUser) {
    throw new Error(`User with email '${normalizedEmail}' already exists`)
  }

  const userId = newId('usr')
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = [...saltBytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  const passwordHash = await hashPassword(opts.password, salt)
  const createdAt = new Date().toISOString()

  const user: CloudUserRow = {
    id: userId,
    email: normalizedEmail,
    password_hash: passwordHash,
    salt,
    name: opts.name.trim(),
    created_at: createdAt,
  }

  await db.exec(
    `INSERT INTO cloud_users (id, email, password_hash, salt, name, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, user.email, user.password_hash, user.salt, user.name, user.created_at],
  )

  const orgId = newId('org')
  const baseSlug = (
    opts.orgSlug ||
    opts.orgName?.toLowerCase().replace(/[^a-z0-9]+/g, '-') ||
    normalizedEmail.split('@')[0]!
  ).replace(/-+/g, '-').replace(/^-|-$/g, '') || 'org'
  const slug = `${baseSlug}-${userId.slice(-6)}`

  const org: OrganizationRow = {
    id: orgId,
    slug,
    name: opts.orgName || `${opts.name}'s Org`,
    tier: 'free',
    owner_id: userId,
    created_at: createdAt,
  }

  await db.exec(
    `INSERT INTO organizations (id, slug, name, tier, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [org.id, org.slug, org.name, org.tier, org.owner_id, org.created_at],
  )

  return { user, org }
}

export async function authenticateUser(
  db: DatabaseAdapter,
  email: string,
  password: string,
): Promise<{ user: CloudUserRow; org: OrganizationRow } | null> {
  const normalizedEmail = email.toLowerCase().trim()
  const user = await db.first<CloudUserRow>(
    `SELECT * FROM cloud_users WHERE email = ?`,
    [normalizedEmail],
  )
  if (!user) {
    return null
  }

  const isValid = await verifyPassword(password, user.password_hash, user.salt)
  if (!isValid) {
    return null
  }

  const org = await db.first<OrganizationRow>(
    `SELECT * FROM organizations WHERE owner_id = ? ORDER BY created_at ASC`,
    [user.id],
  )
  if (!org) {
    return null
  }

  return { user, org }
}

export const TIER_LIMITS: Record<string, number> = {
  free: 100,
  starter: 5000,
  pro: 50000,
  business: Infinity,
}

export async function incrementOrgUsage(
  db: DatabaseAdapter,
  orgId: string,
  monthBucket?: string,
): Promise<OrgUsageMeterRow> {
  const bucket = monthBucket || new Date().toISOString().slice(0, 7)

  const existing = await db.first<OrgUsageMeterRow>(
    `SELECT * FROM org_usage_meters WHERE org_id = ? AND month_bucket = ?`,
    [orgId, bucket],
  )

  if (existing) {
    const newCount = existing.order_count + 1
    await db.exec(
      `UPDATE org_usage_meters SET order_count = ? WHERE org_id = ? AND month_bucket = ?`,
      [newCount, orgId, bucket],
    )
    return { org_id: orgId, month_bucket: bucket, order_count: newCount }
  } else {
    await db.exec(
      `INSERT INTO org_usage_meters (org_id, month_bucket, order_count) VALUES (?, ?, 1)`,
      [orgId, bucket],
    )
    return { org_id: orgId, month_bucket: bucket, order_count: 1 }
  }
}

export async function checkOrgTierLimit(
  db: DatabaseAdapter,
  orgId: string,
  monthBucket?: string,
): Promise<{ allowed: boolean; current: number; limit: number; tier: string }> {
  const org = await db.first<OrganizationRow>(
    `SELECT * FROM organizations WHERE id = ?`,
    [orgId],
  )
  if (!org) {
    throw new Error(`Organization '${orgId}' not found`)
  }

  const bucket = monthBucket || new Date().toISOString().slice(0, 7)
  const meter = await db.first<OrgUsageMeterRow>(
    `SELECT * FROM org_usage_meters WHERE org_id = ? AND month_bucket = ?`,
    [orgId, bucket],
  )

  const current = meter ? meter.order_count : 0
  const limit = TIER_LIMITS[org.tier] ?? TIER_LIMITS['free']!
  const allowed = current < limit

  return { allowed, current, limit, tier: org.tier }
}
