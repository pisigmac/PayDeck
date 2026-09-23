import { describe, expect, it } from 'vitest'
import { dispatchDownstreamWebhook } from '../src/core/webhook-dispatcher'
import { hmacSha256Hex } from '../src/crypto'

describe('dispatchDownstreamWebhook', () => {
  it('dispatches HMAC-signed HTTP POST to product webhook URL when webhookSecret is provided', async () => {
    let capturedUrl = ''
    let capturedMethod = ''
    let capturedBody = ''
    let capturedHeaders: Record<string, string> = {}

    const mockFetch = async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedMethod = String(init?.method)
      capturedBody = String(init?.body)
      capturedHeaders = (init?.headers as Record<string, string>) || {}
      return new Response('OK', { status: 200 })
    }

    const secret = 'whsec_test_secret_123'
    const event = 'payment.paid'
    const data = { payment_id: 'pay_123', amount_paise: 1500, currency: 'INR' }

    const res = await dispatchDownstreamWebhook(
      {
        webhookUrl: 'https://example.com/webhooks/paydeck',
        webhookSecret: secret,
        event,
        data,
      },
      mockFetch as typeof fetch,
    )

    expect(res).toEqual({ ok: true, status: 200 })
    expect(capturedUrl).toBe('https://example.com/webhooks/paydeck')
    expect(capturedMethod).toBe('POST')
    expect(capturedHeaders['Content-Type']).toBe('application/json')
    expect(capturedHeaders['X-PayDeck-Event']).toBe(event)

    const parsedBody = JSON.parse(capturedBody)
    expect(parsedBody.event).toBe(event)
    expect(parsedBody.data).toEqual(data)
    expect(typeof parsedBody.timestamp).toBe('string')

    const expectedSig = await hmacSha256Hex(secret, capturedBody)
    expect(capturedHeaders['X-PayDeck-Signature']).toBe(expectedSig)
  })

  it('dispatches HTTP POST without X-PayDeck-Signature header when webhookSecret is absent', async () => {
    let capturedHeaders: Record<string, string> = {}

    const mockFetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {}
      return new Response('OK', { status: 200 })
    }

    const res = await dispatchDownstreamWebhook(
      {
        webhookUrl: 'https://example.com/webhooks/paydeck',
        webhookSecret: null,
        event: 'payment.created',
        data: { payment_id: 'pay_456' },
      },
      mockFetch as typeof fetch,
    )

    expect(res.ok).toBe(true)
    expect(capturedHeaders['X-PayDeck-Event']).toBe('payment.created')
    expect(capturedHeaders['X-PayDeck-Signature']).toBeUndefined()
  })

  it('returns error when webhookUrl is empty', async () => {
    const res = await dispatchDownstreamWebhook({
      webhookUrl: '',
      event: 'payment.paid',
      data: {},
    })

    expect(res).toEqual({ ok: false, error: 'no_webhook_url' })
  })

  it('returns ok false with HTTP status when webhook endpoint returns non-2xx status', async () => {
    const mockFetch = async () => {
      return new Response('Internal Server Error', { status: 500 })
    }

    const res = await dispatchDownstreamWebhook(
      {
        webhookUrl: 'https://example.com/webhooks',
        event: 'payment.failed',
        data: { payment_id: 'pay_789' },
      },
      mockFetch as typeof fetch,
    )

    expect(res).toEqual({ ok: false, status: 500 })
  })

  it('handles fetch network errors gracefully', async () => {
    const mockFetch = async () => {
      throw new Error('Connection refused')
    }

    const res = await dispatchDownstreamWebhook(
      {
        webhookUrl: 'https://invalid-host-domain.test/webhook',
        event: 'payment.paid',
        data: {},
      },
      mockFetch as typeof fetch,
    )

    expect(res).toEqual({ ok: false, error: 'Connection refused' })
  })
})
