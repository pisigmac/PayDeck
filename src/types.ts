import type { PayDeckConfig } from './config/env'
import type { DatabaseAdapter } from './db/adapter'

export type AppVariables = {
  db: DatabaseAdapter
  config: PayDeckConfig
  auth: AuthContext
  requestId?: string
}

export type ProductRow = {
  id: string
  slug: string
  name: string
  org_id?: string | null
  rate_limit_per_hour: number
  active: number
  webhook_url?: string | null
  webhook_secret?: string | null
  created_at: string
}

export type ApiKeyRow = {
  id: string
  product_id: string
  name: string
  key_prefix: string
  key_hash: string
  environment: string
  last_used_at: string | null
  revoked_at: string | null
  created_at: string
}

export type PlanRow = {
  id: string
  product_id: string
  slug: string
  name: string
  amount_paise: number
  currency: string
  interval: string
  active: number
  created_at: string
}

export type PaymentRow = {
  id: string
  product_id: string
  api_key_id: string | null
  customer_id?: string | null
  plan_id: string | null
  plan_slug: string | null
  amount_paise: number
  currency: string
  status: string
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  receipt: string | null
  notes: string | null
  metadata: string | null
  idempotency_key: string | null
  confirmed_at: string | null
  created_at: string
}

export type CustomerRow = {
  id: string
  product_id: string
  email: string | null
  name: string | null
  external_user_id: string | null
  metadata: string | null
  created_at: string
}

export type CreateCustomerInput = {
  email?: string
  name?: string
  external_user_id?: string
  metadata?: Record<string, unknown>
}

export type RefundRow = {
  id: string
  payment_id: string
  product_id: string
  amount_paise: number
  gateway_refund_id: string | null
  reason: string | null
  status: string
  created_at: string
}

export type AuditLogRow = {
  id: string
  product_id: string | null
  actor: string
  action: string
  target_id: string
  details: string | null
  created_at: string
}

export type WebhookDeliveryRow = {
  id: string
  product_id: string
  event: string
  payload: string
  url: string
  status: string
  attempts: number
  last_attempt_at: string | null
  next_retry_at: string | null
  last_error: string | null
  created_at: string
}

export type PaginationMeta = {
  limit: number
  offset: number
  total: number
}

export type AuthContext = {
  product: ProductRow
  key: ApiKeyRow
}

export type CreateOrderRequest = {
  plan?: string
  amount_paise?: number
  currency?: string
  customer_id?: string
  receipt?: string
  notes?: Record<string, string>
  metadata?: Record<string, unknown>
  description?: string
}

export type VerifyRequest = {
  razorpay_order_id: string
  razorpay_payment_id: string
  razorpay_signature: string
}

export type CloudUserRow = {
  id: string
  email: string
  password_hash: string
  salt: string
  name: string
  created_at: string
}

export type OrganizationRow = {
  id: string
  slug: string
  name: string
  tier: 'free' | 'starter' | 'pro' | 'business'
  owner_id: string
  created_at: string
}

export type OrgUsageMeterRow = {
  org_id: string
  month_bucket: string
  order_count: number
}
