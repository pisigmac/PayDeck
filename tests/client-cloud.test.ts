import { describe, expect, it, vi } from 'vitest'
import { PayDeckClient } from '../src/client'

describe('PayDeckClient Cloud SaaS SDK Methods', () => {
  it('invokes signUp endpoint with user & org details', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'pd_cloud_usr_123',
          user: { id: 'usr_123', email: 'founder@example.com' },
          organization: { id: 'org_123', name: 'SaaS Corp', tier: 'free' },
        }),
        { status: 201 },
      ),
    )

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.signUp({
      email: 'founder@example.com',
      password: 'password123',
      name: 'Founder',
      org_name: 'SaaS Corp',
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.token).toBe('pd_cloud_usr_123')
    }
  })

  it('invokes login endpoint with email and password', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'pd_cloud_usr_123',
          user: { id: 'usr_123', email: 'founder@example.com' },
        }),
        { status: 200 },
      ),
    )

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.login({
      email: 'founder@example.com',
      password: 'password123',
    })

    expect(res.ok).toBe(true)
  })

  it('invokes getCloudMe endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { email: 'founder@example.com' },
          organization: { tier: 'pro' },
          usage: { order_count: 42 },
        }),
        { status: 200 },
      ),
    )

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      adminToken: 'pd_cloud_usr_123',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.getCloudMe()
    expect(res.ok).toBe(true)
  })

  it('invokes upgradeOrgTier endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          organization: { tier: 'business' },
        }),
        { status: 200 },
      ),
    )

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      adminToken: 'pd_cloud_usr_123',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.upgradeOrgTier('business')
    expect(res.ok).toBe(true)
  })
})
