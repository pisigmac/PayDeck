import { createRazorpayOrder, verifyPaymentSignature } from '../razorpay'
import type {
  CreateOrderOpts,
  PaymentGatewayAdapter,
  RefundOpts,
  VerifyPaymentOpts,
} from './adapter'

export class RazorpayGatewayAdapter implements PaymentGatewayAdapter {
  name = 'razorpay'
  private keyId: string
  private keySecret: string

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId
    this.keySecret = keySecret
  }

  async createOrder(opts: CreateOrderOpts) {
    const res = await createRazorpayOrder({
      keyId: this.keyId,
      keySecret: this.keySecret,
      amountPaise: opts.amountPaise,
      currency: opts.currency,
      receipt: opts.receipt,
      notes: opts.notes || {},
    })
    if (!res.ok) {
      return {
        ok: false as const,
        error: typeof res.error === 'string' ? res.error : JSON.stringify(res.error),
      }
    }
    return { ok: true as const, orderId: String(res.order.id), raw: res.order }
  }

  async verifyPayment(opts: VerifyPaymentOpts) {
    return verifyPaymentSignature(this.keySecret, opts.orderId, opts.paymentId, opts.signature)
  }

  async refundPayment(opts: RefundOpts) {
    if (!opts.razorpayPaymentId) {
      return { ok: false as const, error: 'missing_razorpay_payment_id' }
    }
    try {
      const auth = 'Basic ' + btoa(`${this.keyId}:${this.keySecret}`)
      const res = await fetch(
        `https://api.razorpay.com/v1/payments/${encodeURIComponent(opts.razorpayPaymentId)}/refund`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            amount: opts.amountPaise,
            notes: { reason: opts.reason || 'Requested by customer' },
          }),
        },
      )
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const errObj = json.error as Record<string, unknown> | undefined
        return {
          ok: false as const,
          error: String(errObj?.description || res.statusText || 'Refund failed'),
        }
      }
      return { ok: true as const, refundId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }
}
