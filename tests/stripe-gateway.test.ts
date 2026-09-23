import { describe, expect, it, vi } from 'vitest'
import { getGatewayAdapter } from '../src/gateways/adapter'
import { StripeGatewayAdapter } from '../src/gateways/stripe'
import type { PayDeckConfig } from '../src/config/env'

describe('StripeGatewayAdapter', () => {
  const dummyConfig: PayDeckConfig = {
    port: 8787,
    host: '0.0.0.0',
    dbType: 'sqlite',
    dbPath: ':memory:',
    dbUrl: '',
    adminToken: 'secret',
    razorpayKeyId: '',
    razorpayKeySecret: '',
    razorpayWebhookSecret: '',
    allowDevCharge: false,
    rateLimitPerHour: 200,
    allowedOrigins: '*',
    stripeSecretKey: 'sk_test_12345',
  }

  it('name property is "stripe"', () => {
    const stripe = new StripeGatewayAdapter('sk_test_123')
    expect(stripe.name).toBe('stripe')
  })

  it('createOrder posts to Stripe PaymentIntents API with form urlencoded body', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(
        JSON.stringify({
          id: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
          client_secret: 'pi_3MtwBwLkdIwHu7ix28a3tqLD_secret_xyz',
          status: 'requires_payment_method',
        }),
        { status: 200 },
      )
    })

    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as unknown as typeof fetch)
    const res = await stripe.createOrder({
      amountPaise: 1500,
      currency: 'USD',
      receipt: 'rcpt_test_001',
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.orderId).toBe('pi_3MtwBwLkdIwHu7ix28a3tqLD')
      expect(res.raw).toBeDefined()
    }

    expect(capturedUrl).toBe('https://api.stripe.com/v1/payment_intents')
    expect(capturedInit?.method).toBe('POST')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Basic ' + btoa('sk_test_123:'))
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')

    const bodyStr = capturedInit?.body as string
    const params = new URLSearchParams(bodyStr)
    expect(params.get('amount')).toBe('1500')
    expect(params.get('currency')).toBe('usd')
    expect(params.get('description')).toBe('rcpt_test_001')
    expect(params.get('payment_method_types[]')).toBe('card')
  })

  it('createOrder handles API error responses', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Invalid API Key',
            type: 'invalid_request_error',
          },
        }),
        { status: 401 },
      )
    })

    const stripe = new StripeGatewayAdapter('invalid_key', mockFetch as unknown as typeof fetch)
    const res = await stripe.createOrder({
      amountPaise: 1000,
      currency: 'USD',
      receipt: 'rcpt_err',
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('Invalid API Key')
    }
  })

  it('verifyPayment checks PaymentIntent status', async () => {
    let capturedUrl = ''
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url
      return new Response(
        JSON.stringify({
          id: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
          status: 'succeeded',
        }),
        { status: 200 },
      )
    })

    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as unknown as typeof fetch)
    const isVerified = await stripe.verifyPayment({
      orderId: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
      paymentId: 'pay_dummy',
      signature: 'sig_dummy',
    })

    expect(isVerified).toBe(true)
    expect(capturedUrl).toBe('https://api.stripe.com/v1/payment_intents/pi_3MtwBwLkdIwHu7ix28a3tqLD')
  })

  it('verifyPayment returns false for unverified or non-succeeded PaymentIntent', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          id: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
          status: 'requires_payment_method',
        }),
        { status: 200 },
      )
    })

    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as unknown as typeof fetch)
    const isVerified = await stripe.verifyPayment({
      orderId: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
      paymentId: 'pay_dummy',
      signature: 'sig_dummy',
    })

    expect(isVerified).toBe(false)
  })

  it('refundPayment calls Stripe Refunds API', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedUrl = url
      capturedInit = init
      return new Response(
        JSON.stringify({
          id: 're_123456789',
          amount: 500,
          status: 'succeeded',
        }),
        { status: 200 },
      )
    })

    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as unknown as typeof fetch)
    const res = await stripe.refundPayment({
      paymentId: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
      amountPaise: 500,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.refundId).toBe('re_123456789')
      expect(res.raw).toBeDefined()
    }

    expect(capturedUrl).toBe('https://api.stripe.com/v1/refunds')
    expect(capturedInit?.method).toBe('POST')

    const bodyStr = capturedInit?.body as string
    const params = new URLSearchParams(bodyStr)
    expect(params.get('payment_intent')).toBe('pi_3MtwBwLkdIwHu7ix28a3tqLD')
    expect(params.get('amount')).toBe('500')
  })

  it('refundPayment handles refund failure', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'Charge has already been refunded',
          },
        }),
        { status: 400 },
      )
    })

    const stripe = new StripeGatewayAdapter('sk_test_123', mockFetch as unknown as typeof fetch)
    const res = await stripe.refundPayment({
      paymentId: 'pi_3MtwBwLkdIwHu7ix28a3tqLD',
      amountPaise: 500,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('Charge has already been refunded')
    }
  })

  it('getGatewayAdapter returns StripeGatewayAdapter when gateway is "stripe" or stripeSecretKey is configured', () => {
    const stripeAdapter = getGatewayAdapter(dummyConfig, null, 'stripe')
    expect(stripeAdapter).toBeInstanceOf(StripeGatewayAdapter)
    expect(stripeAdapter?.name).toBe('stripe')

    const stripeAdapterEnv = getGatewayAdapter(dummyConfig)
    expect(stripeAdapterEnv).toBeInstanceOf(StripeGatewayAdapter)
  })
})
