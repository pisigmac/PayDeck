import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'

describe('PayDeckClient Admin SDK', () => {
  it('sends X-Admin-Token header on admin calls', async () => {
    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://localhost:8787/v1/admin/products')
      expect((init?.headers as Record<string, string>)?.['X-Admin-Token']).toBe('admin_secret')
      return new Response(JSON.stringify({ products: [{ slug: 'formrelay', name: 'FormRelay' }] }), { status: 200 })
    }

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      adminToken: 'admin_secret',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.listProducts()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.products.length).toBe(1)
    }
  })

  it('fetches audit logs with query params', async () => {
    const mockFetch = async (url: RequestInfo | URL) => {
      expect(String(url)).toContain('/v1/admin/audit-logs?limit=10&offset=5&action=product.created')
      return new Response(JSON.stringify({ audit_logs: [], pagination: { limit: 10, offset: 5, total: 0 } }), { status: 200 })
    }

    const client = new PayDeckClient({
      baseUrl: 'http://localhost:8787',
      adminToken: 'admin_secret',
      fetch: mockFetch as typeof fetch,
    })

    const res = await client.listAuditLogs({ limit: 10, offset: 5, action: 'product.created' })
    expect(res.ok).toBe(true)
  })
})
