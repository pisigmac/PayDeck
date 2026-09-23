import { describe, expect, it, vi } from 'vitest'
import { DevGatewayAdapter } from '../src/gateways/dev'
import { RazorpayGatewayAdapter } from '../src/gateways/razorpay'
import { hmacSha256Hex } from '../src/crypto'

describe('DevGatewayAdapter', () => {
  it('creates order, verifies payment, and refunds payment in dev mode', async () => {
    const dev = new DevGatewayAdapter()
    expect(dev.name).toBe('dev')

    const order = await dev.createOrder({ amountPaise: 500, currency: 'INR', receipt: 'rcpt_1' })
    expect(order.ok).toBe(true)
    if (order.ok) {
      expect(order.orderId).toContain('order_dev_')
      expect(order.raw).toBeDefined()
    }

    const verifyDevSig = await dev.verifyPayment({
      orderId: 'order_123',
      paymentId: 'pay_123',
      signature: 'dev',
    })
    expect(verifyDevSig).toBe(true)

    const verifyDevOrderId = await dev.verifyPayment({
      orderId: 'order_dev_abc123',
      paymentId: 'pay_123',
      signature: 'other',
    })
    expect(verifyDevOrderId).toBe(true)

    const verifyFail = await dev.verifyPayment({
      orderId: 'order_real_123',
      paymentId: 'pay_123',
      signature: 'other',
    })
    expect(verifyFail).toBe(false)

    const refund = await dev.refundPayment({ paymentId: 'pay_1', amountPaise: 500 })
    expect(refund.ok).toBe(true)
    if (refund.ok) {
      expect(refund.refundId).toContain('rfnd_dev_')
      expect(refund.raw).toBeDefined()
    }
  })
})

describe('RazorpayGatewayAdapter', () => {
  const keyId = 'rzp_test_123'
  const keySecret = 'secret_abc123'
  const adapter = new RazorpayGatewayAdapter(keyId, keySecret)

  it('has name razorpay', () => {
    expect(adapter.name).toBe('razorpay')
  })

  it('creates order via Razorpay API', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'order_rzp_999', amount: 1000, currency: 'INR', status: 'created' }),
    } as Response)

    try {
      const res = await adapter.createOrder({
        amountPaise: 1000,
        currency: 'INR',
        receipt: 'rcpt_test',
        notes: { plan: 'pro' },
      })
      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.orderId).toBe('order_rzp_999')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('handles order creation failure', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { code: 'BAD_REQUEST_ERROR', description: 'Amount too low' } }),
    } as Response)

    try {
      const res = await adapter.createOrder({
        amountPaise: 1,
        currency: 'INR',
        receipt: 'rcpt_low',
      })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toContain('Amount too low')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('verifies payment signature correctly', async () => {
    const orderId = 'order_123'
    const paymentId = 'pay_456'
    const signature = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`)

    const valid = await adapter.verifyPayment({ orderId, paymentId, signature })
    expect(valid).toBe(true)

    const invalid = await adapter.verifyPayment({ orderId, paymentId, signature: 'invalid' })
    expect(invalid).toBe(false)
  })

  it('refunds payment via Razorpay API', async () => {
    const originalFetch = globalThis.fetch
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody = ''

    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedHeaders = (init?.headers as Record<string, string>) || {}
      capturedBody = String(init?.body || '')
      return {
        ok: true,
        json: async () => ({ id: 'rfnd_rzp_777', payment_id: 'pay_rzp_123', amount: 500, status: 'processed' }),
      } as Response
    })

    try {
      const res = await adapter.refundPayment({
        paymentId: 'pd_pay_1',
        razorpayPaymentId: 'pay_rzp_123',
        amountPaise: 500,
        reason: 'Customer requested',
      })

      expect(res.ok).toBe(true)
      if (res.ok) {
        expect(res.refundId).toBe('rfnd_rzp_777')
      }
      expect(capturedUrl).toBe('https://api.razorpay.com/v1/payments/pay_rzp_123/refund')
      expect(capturedHeaders['Authorization']).toBe(`Basic ${btoa(`${keyId}:${keySecret}`)}`)
      expect(capturedBody).toContain('"amount":500')
      expect(capturedBody).toContain('Customer requested')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('returns error when razorpayPaymentId is missing for refund', async () => {
    const res = await adapter.refundPayment({
      paymentId: 'pd_pay_1',
      amountPaise: 500,
    })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('missing_razorpay_payment_id')
    }
  })

  it('handles refund API error response', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: async () => ({ error: { description: 'Payment already refunded' } }),
    } as Response)

    try {
      const res = await adapter.refundPayment({
        paymentId: 'pd_pay_1',
        razorpayPaymentId: 'pay_rzp_123',
        amountPaise: 500,
      })

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error).toBe('Payment already refunded')
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
