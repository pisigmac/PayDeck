import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'

describe('PayDeckClient Subscriptions SDK', () => {
  describe('createSubscription', () => {
    it('calls POST /v1/subscriptions with customer_id, plan_id, and period_days', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined

      const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(
          JSON.stringify({
            id: 'sub_123',
            customer_id: 'cust_abc',
            plan_id: 'plan_pro',
            status: 'active',
            current_period_start: '2026-08-24T00:00:00.000Z',
            current_period_end: '2026-09-23T00:00:00.000Z',
          }),
          { status: 201 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.createSubscription({
        customer_id: 'cust_abc',
        plan_id: 'plan_pro',
        period_days: 30,
      })

      expect(capturedUrl).toBe('http://localhost:8787/v1/subscriptions')
      expect(capturedInit?.method).toBe('POST')
      expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe('Bearer pk_test_123')
      expect(JSON.parse(String(capturedInit?.body))).toEqual({
        customer_id: 'cust_abc',
        plan_id: 'plan_pro',
        period_days: 30,
      })

      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.id).toBe('sub_123')
        expect(res.data.status).toBe('active')
      }
    })

    it('returns error when POST /v1/subscriptions fails', async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({ error: 'customer_not_found' }),
          { status: 404 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.createSubscription({
        customer_id: 'cust_nonexistent',
        plan_id: 'plan_pro',
      })

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(404)
        expect(res.error).toBe('customer_not_found')
      }
    })
  })

  describe('listSubscriptions', () => {
    it('calls GET /v1/subscriptions with query options', async () => {
      let capturedUrl = ''

      const mockFetch = async (url: RequestInfo | URL) => {
        capturedUrl = String(url)
        return new Response(
          JSON.stringify({
            subscriptions: [
              { id: 'sub_123', customer_id: 'cust_abc', plan_id: 'plan_pro', status: 'active' },
            ],
            pagination: { limit: 10, offset: 0, total: 1 },
          }),
          { status: 200 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.listSubscriptions({ limit: 10, offset: 0, customer_id: 'cust_abc' })

      expect(capturedUrl).toBe('http://localhost:8787/v1/subscriptions?limit=10&offset=0&customer_id=cust_abc')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.subscriptions.length).toBe(1)
        expect(res.data.pagination).toEqual({ limit: 10, offset: 0, total: 1 })
      }
    })

    it('calls GET /v1/subscriptions without query options when none provided', async () => {
      let capturedUrl = ''

      const mockFetch = async (url: RequestInfo | URL) => {
        capturedUrl = String(url)
        return new Response(
          JSON.stringify({
            subscriptions: [],
            pagination: { limit: 25, offset: 0, total: 0 },
          }),
          { status: 200 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.listSubscriptions()

      expect(capturedUrl).toBe('http://localhost:8787/v1/subscriptions')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.subscriptions).toEqual([])
      }
    })

    it('returns error when GET /v1/subscriptions fails', async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({ error: 'unauthorized' }),
          { status: 401 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.listSubscriptions()

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(401)
        expect(res.error).toBe('unauthorized')
      }
    })
  })

  describe('cancelSubscription', () => {
    it('calls POST /v1/subscriptions/:id/cancel with immediately parameter', async () => {
      let capturedUrl = ''
      let capturedInit: RequestInit | undefined

      const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(url)
        capturedInit = init
        return new Response(
          JSON.stringify({
            id: 'sub_123',
            status: 'canceled',
          }),
          { status: 200 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.cancelSubscription('sub_123', true)

      expect(capturedUrl).toBe('http://localhost:8787/v1/subscriptions/sub_123/cancel')
      expect(capturedInit?.method).toBe('POST')
      expect(JSON.parse(String(capturedInit?.body))).toEqual({ immediately: true })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.id).toBe('sub_123')
        expect(res.data.status).toBe('canceled')
      }
    })

    it('returns error when cancel fails', async () => {
      const mockFetch = async () => {
        return new Response(
          JSON.stringify({ error: 'subscription_not_found' }),
          { status: 404 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_test_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.cancelSubscription('sub_unknown')

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(404)
        expect(res.error).toBe('subscription_not_found')
      }
    })
  })
})
