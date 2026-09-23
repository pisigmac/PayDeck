import { describe, expect, it } from 'vitest'
import { PayDeckClient } from '../src/client'
import { hmacSha256Hex, mintApiKey, timingSafeEqual } from '../src/crypto'
import { hourBucket, isValidPlanInterval } from '../src/policy'
import {
  razorpayConfigured,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../src/razorpay'

describe('hmacSha256Hex', () => {
  it('is deterministic', async () => {
    const a = await hmacSha256Hex('secret', 'payload')
    const b = await hmacSha256Hex('secret', 'payload')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes with payload', async () => {
    const a = await hmacSha256Hex('secret', 'a')
    const b = await hmacSha256Hex('secret', 'b')
    expect(a).not.toBe(b)
  })
})

describe('mintApiKey', () => {
  it('generates pd_live_ key with 14-char prefix', async () => {
    const res = await mintApiKey('live')
    expect(res.raw).toMatch(/^pd_live_[0-9a-f]{48}$/)
    expect(res.prefix).toBe(res.raw.slice(0, 14))
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates pd_test_ key', async () => {
    const res = await mintApiKey('test')
    expect(res.raw).toMatch(/^pd_test_[0-9a-f]{48}$/)
    expect(res.prefix).toBe(res.raw.slice(0, 14))
  })
})

describe('PayDeckClient', () => {
  it('initializes and formats requests', async () => {
    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.paydeck.com/v1/orders')
      expect((init?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer pd_live_123')
      return new Response(JSON.stringify({ id: 'pay_1', status: 'created', amount: 1000, currency: 'INR' }), { status: 200 })
    }
    const client = new PayDeckClient({ baseUrl: 'https://api.paydeck.com', apiKey: 'pd_live_123', fetch: mockFetch as typeof fetch })
    const res = await client.createOrder({ amount_paise: 1000 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.id).toBe('pay_1')
      expect(res.data.amount).toBe(1000)
    }
  })
})

describe('timingSafeEqual', () => {
  it('equals same strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
  })

  it('rejects different length', () => {
    expect(timingSafeEqual('ab', 'abc')).toBe(false)
  })

  it('rejects different content', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
  })
})

describe('verifyPaymentSignature', () => {
  it('accepts valid Razorpay checkout signature', async () => {
    const secret = 'test_secret'
    const orderId = 'order_ABC'
    const paymentId = 'pay_XYZ'
    const signature = await hmacSha256Hex(secret, `${orderId}|${paymentId}`)
    expect(await verifyPaymentSignature(secret, orderId, paymentId, signature)).toBe(true)
  })

  it('rejects tampered signature', async () => {
    const ok = await verifyPaymentSignature('secret', 'order_1', 'pay_1', 'deadbeef')
    expect(ok).toBe(false)
  })
})

describe('verifyWebhookSignature', () => {
  it('accepts valid webhook HMAC of raw body', async () => {
    const secret = 'whsec'
    const body = '{"event":"payment.captured"}'
    const signature = await hmacSha256Hex(secret, body)
    expect(await verifyWebhookSignature(secret, body, signature)).toBe(true)
  })

  it('rejects bad webhook signature', async () => {
    expect(await verifyWebhookSignature('whsec', '{}', 'nope')).toBe(false)
  })
})

describe('razorpayConfigured', () => {
  it('requires both key id and secret', () => {
    expect(razorpayConfigured({})).toBe(false)
    expect(razorpayConfigured({ RAZORPAY_KEY_ID: 'rzp_test' })).toBe(false)
    expect(
      razorpayConfigured({ RAZORPAY_KEY_ID: 'rzp_test', RAZORPAY_KEY_SECRET: 'sec' }),
    ).toBe(true)
  })
})

describe('policy helpers', () => {
  it('hourBucket shape', () => {
    expect(hourBucket(new Date('2026-08-09T13:22:00Z'))).toBe('2026-08-09T13')
  })

  it('validates plan intervals', () => {
    expect(isValidPlanInterval('month')).toBe(true)
    expect(isValidPlanInterval('year')).toBe(true)
    expect(isValidPlanInterval('one_time')).toBe(true)
    expect(isValidPlanInterval('week')).toBe(false)
  })
})
