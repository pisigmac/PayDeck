import type {
  CreateOrderOpts,
  PaymentGatewayAdapter,
  RefundOpts,
  VerifyPaymentOpts,
} from './adapter'

export class StripeGatewayAdapter implements PaymentGatewayAdapter {
  name = 'stripe'
  private secretKey: string
  private fetchFn: typeof fetch

  constructor(secretKey: string, fetchFn: typeof fetch = fetch) {
    this.secretKey = secretKey
    this.fetchFn = fetchFn
  }

  private authHeader(): string {
    return 'Basic ' + btoa(`${this.secretKey}:`)
  }

  async createOrder(opts: CreateOrderOpts) {
    try {
      const params = new URLSearchParams()
      params.set('amount', String(opts.amountPaise))
      params.set('currency', opts.currency.toLowerCase())
      params.set('description', opts.receipt)
      params.set('payment_method_types[]', 'card')

      const res = await this.fetchFn('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      })

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const errObj = json.error as Record<string, unknown> | undefined
        return {
          ok: false as const,
          error: String(errObj?.message || res.statusText || 'Stripe create order failed'),
        }
      }

      return { ok: true as const, orderId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }

  async verifyPayment(opts: VerifyPaymentOpts): Promise<boolean> {
    try {
      const res = await this.fetchFn(
        `https://api.stripe.com/v1/payment_intents/${encodeURIComponent(opts.orderId)}`,
        {
          headers: {
            Authorization: this.authHeader(),
          },
        },
      )
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      return res.ok && json.status === 'succeeded'
    } catch {
      return false
    }
  }

  async refundPayment(opts: RefundOpts) {
    try {
      const params = new URLSearchParams()
      const paymentIntentId = opts.razorpayPaymentId || opts.paymentId
      params.set('payment_intent', paymentIntentId)
      params.set('amount', String(opts.amountPaise))

      const res = await this.fetchFn('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers: {
          Authorization: this.authHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      })

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) {
        const errObj = json.error as Record<string, unknown> | undefined
        return {
          ok: false as const,
          error: String(errObj?.message || res.statusText || 'Stripe refund failed'),
        }
      }

      return { ok: true as const, refundId: String(json.id), raw: json }
    } catch (e) {
      return { ok: false as const, error: (e as Error).message }
    }
  }
}
