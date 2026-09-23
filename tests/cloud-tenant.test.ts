import { describe, expect, it } from 'vitest'
import { SQLiteAdapter } from '../src/db/sqlite'
import {
  authenticateUser,
  checkOrgTierLimit,
  createTenantUser,
  hashPassword,
  incrementOrgUsage,
  verifyPassword,
} from '../src/core/cloud-tenant'

async function setupTestDb() {
  const db = new SQLiteAdapter(':memory:')
  await db.exec(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free',
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE cloud_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE org_usage_meters (
      org_id TEXT NOT NULL,
      month_bucket TEXT NOT NULL,
      order_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (org_id, month_bucket)
    );

    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      org_id TEXT
    );
  `)
  return db
}

describe('Cloud Multi-Tenant Core Engine', () => {
  it('hashes and verifies passwords securely', async () => {
    const password = 'SecretPassword123!'
    const salt = 'abc123salt'
    const hash = await hashPassword(password, salt)

    expect(hash).toBeTypeOf('string')
    expect(hash.length).toBe(64)

    const valid = await verifyPassword(password, hash, salt)
    expect(valid).toBe(true)

    const invalid = await verifyPassword('WrongPassword', hash, salt)
    expect(invalid).toBe(false)
  })

  it('registers user and creates default organization', async () => {
    const db = await setupTestDb()
    const result = await createTenantUser(db, {
      email: 'founder@example.com',
      password: 'password123',
      name: 'Alice Founder',
      orgName: 'Acme SaaS',
      orgSlug: 'acme-saas',
    })

    expect(result.user.id).toMatch(/^usr_/)
    expect(result.user.email).toBe('founder@example.com')
    expect(result.user.name).toBe('Alice Founder')

    expect(result.org.id).toMatch(/^org_/)
    expect(result.org.slug).toMatch(/^acme-saas/)
    expect(result.org.name).toBe('Acme SaaS')
    expect(result.org.tier).toBe('free')
    expect(result.org.owner_id).toBe(result.user.id)

    await db.close?.()
  })

  it('authenticates valid users and rejects invalid credentials', async () => {
    const db = await setupTestDb()
    await createTenantUser(db, {
      email: 'bob@example.com',
      password: 'mypassword',
      name: 'Bob Developer',
    })

    const authenticated = await authenticateUser(db, 'bob@example.com', 'mypassword')
    expect(authenticated).not.toBeNull()
    expect(authenticated?.user.email).toBe('bob@example.com')
    expect(authenticated?.org.name).toBe("Bob Developer's Org")

    const badPass = await authenticateUser(db, 'bob@example.com', 'wrongpass')
    expect(badPass).toBeNull()

    const badEmail = await authenticateUser(db, 'nobody@example.com', 'mypassword')
    expect(badEmail).toBeNull()

    await db.close?.()
  })

  it('increments usage meters and checks tier limits', async () => {
    const db = await setupTestDb()
    const { org } = await createTenantUser(db, {
      email: 'carol@example.com',
      password: 'password123',
      name: 'Carol Founder',
    })

    const check1 = await checkOrgTierLimit(db, org.id, '2026-08')
    expect(check1.allowed).toBe(true)
    expect(check1.current).toBe(0)
    expect(check1.limit).toBe(100)
    expect(check1.tier).toBe('free')

    const m1 = await incrementOrgUsage(db, org.id, '2026-08')
    expect(m1.order_count).toBe(1)

    const m2 = await incrementOrgUsage(db, org.id, '2026-08')
    expect(m2.order_count).toBe(2)

    const check2 = await checkOrgTierLimit(db, org.id, '2026-08')
    expect(check2.current).toBe(2)
    expect(check2.allowed).toBe(true)

    await db.exec(
      `UPDATE org_usage_meters SET order_count = 100 WHERE org_id = ? AND month_bucket = ?`,
      [org.id, '2026-08'],
    )
    const check3 = await checkOrgTierLimit(db, org.id, '2026-08')
    expect(check3.current).toBe(100)
    expect(check3.allowed).toBe(false)

    await db.exec(`UPDATE organizations SET tier = 'starter' WHERE id = ?`, [org.id])
    const check4 = await checkOrgTierLimit(db, org.id, '2026-08')
    expect(check4.tier).toBe('starter')
    expect(check4.limit).toBe(5000)
    expect(check4.allowed).toBe(true)

    await db.close?.()
  })
})
