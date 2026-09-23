import { hmacSha256Hex, timingSafeEqual } from './crypto'

export async function verifyPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`)
  return timingSafeEqual(expected, signature)
}

/** Razorpay webhook: HMAC-SHA256 of raw body, header X-Razorpay-Signature. */
export async function verifyWebhookSignature(
  webhookSecret: string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const expected = await hmacSha256Hex(webhookSecret, rawBody)
  return timingSafeEqual(expected, signature)
}

export async function createRazorpayOrder(opts: {
  keyId: string
  keySecret: string
  amountPaise: number
  currency?: string
  receipt: string
  notes: Record<string, string>
}): Promise<{ ok: true; order: Record<string, unknown> } | { ok: false; error: unknown }> {
  const auth = btoa(`${opts.keyId}:${opts.keySecret}`)
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: opts.amountPaise,
      currency: opts.currency || 'INR',
      receipt: opts.receipt,
      notes: opts.notes,
    }),
  })
  const data = (await res.json()) as Record<string, unknown>
  if (!res.ok) return { ok: false, error: data }
  return { ok: true, order: data }
}

export function razorpayConfigured(env: {
  RAZORPAY_KEY_ID?: string
  RAZORPAY_KEY_SECRET?: string
}): boolean {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
}
