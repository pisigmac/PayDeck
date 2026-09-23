import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('PayDeck Cloud SaaS Routes (/v1/cloud)', () => {
  let token = ''
  const testEmail = `founder_${Date.now()}@example.com`

  it('POST /v1/cloud/signup registers user and tenant organization', async () => {
    const res = await app.request('/v1/cloud/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'password123',
        name: 'Jane SaaS Founder',
        org_name: 'Acme Billing SaaS',
      }),
    })
    const json: any = await res.json()
    console.log("SIGNUP RESPONSE:", json)
    expect(res.status).toBe(201)
    expect(json.token).toBeDefined()
    expect(json.user.email).toBe(testEmail)
    expect(json.organization.name).toBe('Acme Billing SaaS')
    expect(json.organization.tier).toBe('free')
    token = json.token
  })

  it('POST /v1/cloud/login authenticates user and returns token', async () => {
    const res = await app.request('/v1/cloud/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testEmail,
        password: 'password123',
      }),
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.token).toBeDefined()
    expect(json.user.email).toBe(testEmail)
  })

  it('GET /v1/cloud/me returns current user, org, usage meter, and tier limits', async () => {
    const res = await app.request('/v1/cloud/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.user.email).toBe(testEmail)
    expect(json.organization.tier).toBe('free')
    expect(json.usage.order_count).toBeDefined()
    expect(json.tier_limits.orders_per_month).toBe(100)
  })

  it('POST /v1/cloud/org/upgrade updates organization tier to pro', async () => {
    const res = await app.request('/v1/cloud/org/upgrade', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tier: 'pro' }),
    })
    expect(res.status).toBe(200)
    const json: any = await res.json()
    expect(json.organization.tier).toBe('pro')
  })
})
