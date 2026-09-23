/**
 * Tiny typed client for product Workers / Node.
 * Usage:
 *   const billing = new PayDeckClient({ baseUrl, apiKey })
 *   await billing.createOrder({ plan: 'pro', idempotencyKey: '…' })
 */
export type BillingClientOptions = {
  baseUrl: string
  apiKey?: string
  adminToken?: string
  fetch?: typeof fetch
  retries?: number
}

export type CreateOrderInput = {
  plan?: string
  amount_paise?: number
  currency?: string
  receipt?: string
  notes?: Record<string, string>
  metadata?: Record<string, unknown>
  description?: string
  idempotencyKey?: string
}

export type VerifyInput = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

export type CreateCustomerInput = {
  email?: string
  name?: string
  external_user_id?: string
  metadata?: Record<string, unknown>
}

export type CreateSubscriptionInput = {
  customer_id: string
  plan_id: string
  period_days?: number
}

export type ListSubscriptionsOpts = {
  limit?: number
  offset?: number
  customer_id?: string
}

export type ClientResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; detail?: unknown }

export class PayDeckClient {
  private baseUrl: string
  private apiKey?: string
  private adminToken?: string
  private fetchFn: typeof fetch
  private retries: number

  constructor(opts: BillingClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.apiKey = opts.apiKey
    this.adminToken = opts.adminToken
    this.fetchFn = opts.fetch || fetch
    this.retries = opts.retries ?? 3
  }

  private async fetchWithRetry(url: string, init?: RequestInit): Promise<Response> {
    const maxRetries = this.retries
    const retryableStatuses = new Set([429, 500, 502, 503, 504])

    let attempt = 0
    while (true) {
      try {
        const res = await this.fetchFn(url, init)
        if (retryableStatuses.has(res.status) && attempt < maxRetries) {
          const delay = 100 * Math.pow(2, attempt)
          await new Promise((resolve) => setTimeout(resolve, delay))
          attempt++
          continue
        }
        return res
      } catch (err) {
        if (attempt < maxRetries) {
          const delay = 100 * Math.pow(2, attempt)
          await new Promise((resolve) => setTimeout(resolve, delay))
          attempt++
          continue
        }
        throw err
      }
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
    }
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`
    }
    if (this.adminToken) {
      h['X-Admin-Token'] = this.adminToken
    }
    return h
  }

  static async verifyWebhookSignature(
    payload: string,
    signature: string,
    secret: string,
  ): Promise<boolean> {
    if (!payload || !signature || !secret) return false
    try {
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
      const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
      const expectedSig = [...new Uint8Array(sigBuffer)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')

      const a = expectedSig.toLowerCase()
      const b = signature.trim().toLowerCase()
      if (a.length !== b.length) return false
      let out = 0
      for (let i = 0; i < a.length; i++) {
        out |= a.charCodeAt(i) ^ b.charCodeAt(i)
      }
      return out === 0
    } catch {
      return false
    }
  }

  async createOrder(input: CreateOrderInput): Promise<
    ClientResult<{
      id: string
      status: string
      order_id: string | null
      key_id: string | null
      amount: number
      currency: string
      plan?: string | null
      mode?: string
    }>
  > {
    const headers = this.headers()
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey

    const { idempotencyKey: _ik, ...body } = input
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: {
        id: String(json.id),
        status: String(json.status),
        order_id: (json.order_id as string | null) ?? null,
        key_id: (json.key_id as string | null) ?? null,
        amount: Number(json.amount),
        currency: String(json.currency || 'INR'),
        plan: (json.plan as string | null | undefined) ?? null,
        mode: json.mode ? String(json.mode) : undefined,
      },
    }
  }

  async verify(input: VerifyInput): Promise<ClientResult<{ ok: true; payment: unknown }>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/verify`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: { ok: true, payment: json.payment } }
  }

  async getPayment(id: string): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/payments/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async refundPayment(
    paymentId: string,
    input: { amount_paise?: number; reason?: string } = {},
  ): Promise<ClientResult<{ ok: true; refund: unknown; payment: unknown }>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
      },
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: {
        ok: true,
        refund: json.refund,
        payment: json.payment,
      },
    }
  }

  async listPayments(limit = 25, offset = 0): Promise<ClientResult<{ payments: unknown[]; pagination?: unknown }>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/payments?limit=${limit}&offset=${offset}`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: { payments: (json.payments as unknown[]) || [], pagination: json.pagination } }
  }

  async listPlans(): Promise<ClientResult<{ plans: unknown[] }>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/plans`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: { plans: (json.plans as unknown[]) || [] } }
  }

  // --- Customer Methods ---

  async createCustomer(input: CreateCustomerInput): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/customers`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async listCustomers(
    limit = 25,
    offset = 0,
  ): Promise<ClientResult<{ customers: unknown[]; pagination?: unknown }>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/v1/customers?limit=${limit}&offset=${offset}`,
      {
        headers: this.headers(),
      },
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: { customers: (json.customers as unknown[]) || [], pagination: json.pagination },
    }
  }

  async listCustomerPayments(
    customerId: string,
    limit = 25,
    offset = 0,
  ): Promise<ClientResult<{ payments: unknown[]; pagination?: unknown }>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/v1/customers/${encodeURIComponent(customerId)}/payments?limit=${limit}&offset=${offset}`,
      {
        headers: this.headers(),
      },
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: { payments: (json.payments as unknown[]) || [], pagination: json.pagination },
    }
  }

  // --- Subscription Methods ---

  async createSubscription(input: {
    customer_id: string
    plan_id: string
    period_days?: number
  }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/subscriptions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async listSubscriptions(opts?: {
    limit?: number
    offset?: number
    customer_id?: string
  }): Promise<ClientResult<{ subscriptions: unknown[]; pagination?: unknown }>> {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset))
    if (opts?.customer_id) params.set('customer_id', opts.customer_id)

    const queryStr = params.toString()
    const url = `${this.baseUrl}/v1/subscriptions${queryStr ? `?${queryStr}` : ''}`

    const res = await this.fetchWithRetry(url, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: { subscriptions: (json.subscriptions as unknown[]) || [], pagination: json.pagination },
    }
  }

  async cancelSubscription(
    id: string,
    immediately?: boolean,
  ): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/v1/subscriptions/${encodeURIComponent(id)}/cancel`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ immediately }),
      },
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  // --- Admin Methods ---

  async createProduct(input: { slug: string; name: string; rate_limit_per_hour?: number }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/products`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: json }
  }

  async listProducts(): Promise<ClientResult<{ products: unknown[] }>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/products`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: { products: (json.products as unknown[]) || [] } }
  }

  async mintKey(slug: string, input?: { name?: string; environment?: 'live' | 'test' }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/products/${encodeURIComponent(slug)}/keys`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input || {}),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: json }
  }

  async revokeKey(slug: string, keyId: string): Promise<ClientResult<{ ok: boolean }>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/products/${encodeURIComponent(slug)}/keys/${encodeURIComponent(keyId)}/revoke`, {
      method: 'POST',
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: { ok: true } }
  }

  async createPlan(slug: string, input: { slug: string; name: string; amount_paise: number; currency?: string; interval?: string }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/products/${encodeURIComponent(slug)}/plans`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: json }
  }

  async listAuditLogs(opts?: { limit?: number; offset?: number; product_id?: string; action?: string }): Promise<ClientResult<{ audit_logs: unknown[]; pagination?: unknown }>> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    if (opts?.product_id) params.set('product_id', opts.product_id)
    if (opts?.action) params.set('action', opts.action)

    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/admin/audit-logs?${params.toString()}`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) return { ok: false, status: res.status, error: String(json.error || res.statusText), detail: json }
    return { ok: true, data: { audit_logs: (json.audit_logs as unknown[]) || [], pagination: json.pagination } }
  }

  async adminRefundPayment(
    paymentId: string,
    input: { amount_paise?: number; reason?: string } = {},
  ): Promise<ClientResult<{ ok: true; refund: unknown; payment: unknown }>> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/v1/admin/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
      },
    )
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return {
      ok: true,
      data: {
        ok: true,
        refund: json.refund,
        payment: json.payment,
      },
    }
  }

  // --- Cloud SaaS Methods ---

  async signUp(input: {
    email: string
    password: string
    name: string
    org_name?: string
    orgName?: string
  }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/cloud/signup`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async login(input: {
    email: string
    password: string
  }): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/cloud/login`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async getCloudMe(): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/cloud/me`, {
      headers: this.headers(),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }

  async upgradeOrgTier(tier: string): Promise<ClientResult<Record<string, unknown>>> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/v1/cloud/org/upgrade`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ tier }),
    })
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: String(json.error || res.statusText),
        detail: json,
      }
    }
    return { ok: true, data: json }
  }
}

export { PayDeckClient as PayDeck, PayDeckClient as DeskBillClient, PayDeckClient as DeskBill, PayDeckClient as PisigmaBilling }
