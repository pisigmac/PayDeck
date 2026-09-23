import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'

async function computeHmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  return [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

describe('PayDeckClient Resilience & Webhook Signature', () => {
  describe('verifyWebhookSignature static method', () => {
    it('verifies valid webhook signature correctly', async () => {
      const payload = JSON.stringify({ event: 'payment.paid', id: 'pay_123' })
      const secret = 'webhook_secret_key_456'
      const validSig = await computeHmacSha256Hex(secret, payload)

      const isValid = await PayDeckClient.verifyWebhookSignature(payload, validSig, secret)
      expect(isValid).toBe(true)
    })

    it('rejects invalid or tampered signature', async () => {
      const payload = JSON.stringify({ event: 'payment.paid', id: 'pay_123' })
      const secret = 'webhook_secret_key_456'
      const tamperedSig = 'a'.repeat(64)

      const isValid = await PayDeckClient.verifyWebhookSignature(payload, tamperedSig, secret)
      expect(isValid).toBe(false)
    })

    it('rejects payload if secret is wrong', async () => {
      const payload = JSON.stringify({ event: 'payment.paid', id: 'pay_123' })
      const sig = await computeHmacSha256Hex('secret_A', payload)

      const isValid = await PayDeckClient.verifyWebhookSignature(payload, sig, 'secret_B')
      expect(isValid).toBe(false)
    })

    it('handles empty parameters gracefully', async () => {
      expect(await PayDeckClient.verifyWebhookSignature('', 'sig', 'secret')).toBe(false)
      expect(await PayDeckClient.verifyWebhookSignature('payload', '', 'secret')).toBe(false)
      expect(await PayDeckClient.verifyWebhookSignature('payload', 'sig', '')).toBe(false)
    })
  })

  describe('Auto-Retries on 429/5xx and network exceptions', () => {
    it('retries on 429 response and succeeds on retry', async () => {
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        if (attempts < 3) {
          return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 })
        }
        return new Response(JSON.stringify({ plans: [{ id: 'plan_1' }] }), { status: 200 })
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
        retries: 3,
      })

      const res = await client.listPlans()
      expect(res.ok).toBe(true)
      expect(attempts).toBe(3)
    })

    it('retries on 503 response and fails after max retries', async () => {
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        return new Response(JSON.stringify({ error: 'service_unavailable' }), { status: 503 })
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
        retries: 2,
      })

      const res = await client.listPlans()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(503)
      }
      expect(attempts).toBe(3) // 1 initial call + 2 retries
    })

    it('retries on network exceptions (fetchFn throw) and succeeds on retry', async () => {
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        if (attempts < 2) {
          throw new TypeError('Network connection lost')
        }
        return new Response(JSON.stringify({ plans: [] }), { status: 200 })
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
        retries: 2,
      })

      const res = await client.listPlans()
      expect(res.ok).toBe(true)
      expect(attempts).toBe(2)
    })

    it('does not retry on 400 Bad Request or 404 Not Found', async () => {
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        return new Response(JSON.stringify({ error: 'invalid_json' }), { status: 400 })
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
        retries: 3,
      })

      const res = await client.getPayment('pay_unknown')
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(400)
      }
      expect(attempts).toBe(1)
    })

    it('respects retries = 0 setting', async () => {
      let attempts = 0
      const mockFetch = async () => {
        attempts++
        return new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 })
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
        retries: 0,
      })

      const res = await client.listPlans()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(500)
      }
      expect(attempts).toBe(1)
    })
  })

  describe('Customer SDK methods', () => {
    it('calls POST /v1/customers via createCustomer', async () => {
      const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(String(url)).toBe('http://localhost:8787/v1/customers')
        expect(init?.method).toBe('POST')
        const body = JSON.parse(String(init?.body))
        expect(body.email).toBe('test@example.com')
        expect(body.name).toBe('Test User')
        return new Response(
          JSON.stringify({ id: 'cust_123', email: 'test@example.com', name: 'Test User' }),
          { status: 201 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        apiKey: 'pk_live_123',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.createCustomer({ email: 'test@example.com', name: 'Test User' })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.id).toBe('cust_123')
      }
    })

    it('calls GET /v1/customers via listCustomers', async () => {
      const mockFetch = async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('http://localhost:8787/v1/customers?limit=10&offset=5')
        return new Response(
          JSON.stringify({
            customers: [{ id: 'cust_123' }],
            pagination: { limit: 10, offset: 5, total: 1 },
          }),
          { status: 200 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.listCustomers(10, 5)
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.customers.length).toBe(1)
      }
    })

    it('calls GET /v1/customers/:id/payments via listCustomerPayments', async () => {
      const mockFetch = async (url: RequestInfo | URL) => {
        expect(String(url)).toBe('http://localhost:8787/v1/customers/cust_123/payments?limit=25&offset=0')
        return new Response(
          JSON.stringify({
            payments: [{ id: 'pay_1' }],
            pagination: { limit: 25, offset: 0, total: 1 },
          }),
          { status: 200 },
        )
      }

      const client = new PayDeckClient({
        baseUrl: 'http://localhost:8787',
        fetch: mockFetch as typeof fetch,
      })

      const res = await client.listCustomerPayments('cust_123')
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.data.payments.length).toBe(1)
      }
    })
  })
})
