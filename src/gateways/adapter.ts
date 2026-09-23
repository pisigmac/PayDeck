export interface CreateOrderOpts {
  amountPaise: number
  currency: string
  receipt: string
  notes?: Record<string, string>
}

export interface VerifyPaymentOpts {
  orderId: string
  paymentId: string
  signature: string
}

export interface RefundOpts {
  paymentId: string
  razorpayPaymentId?: string
  amountPaise: number
  reason?: string
}

export interface PaymentGatewayAdapter {
  name: string
  createOrder(
    opts: CreateOrderOpts,
  ): Promise<{ ok: true; orderId: string; raw?: unknown } | { ok: false; error: string }>
  verifyPayment(opts: VerifyPaymentOpts): Promise<boolean>
  refundPayment(
    opts: RefundOpts,
  ): Promise<{ ok: true; refundId: string; raw?: unknown } | { ok: false; error: string }>
}

import type { PayDeckConfig } from '../config/env'
import { razorpayConfigured } from '../razorpay'
import { DevGatewayAdapter } from './dev'
import { RazorpayGatewayAdapter } from './razorpay'
import { StripeGatewayAdapter } from './stripe'

export function getGatewayAdapter(
  config: PayDeckConfig,
  razorpayOrderId?: string | null,
  gateway?: string | null,
): PaymentGatewayAdapter | null {
  if (razorpayOrderId?.startsWith('order_dev_')) {
    return new DevGatewayAdapter()
  }

  const stripeKey = config.stripeSecretKey || process.env.STRIPE_SECRET_KEY
  const isStripeExplicit =
    gateway === 'stripe' || razorpayOrderId === 'stripe' || razorpayOrderId?.startsWith('pi_')
  const isRazorpayExplicit =
    gateway === 'razorpay' || (razorpayOrderId && razorpayOrderId.startsWith('order_'))

  if (
    isRazorpayExplicit &&
    razorpayConfigured({
      RAZORPAY_KEY_ID: config.razorpayKeyId,
      RAZORPAY_KEY_SECRET: config.razorpayKeySecret,
    })
  ) {
    return new RazorpayGatewayAdapter(config.razorpayKeyId!, config.razorpayKeySecret!)
  }

  if (isStripeExplicit || stripeKey) {
    if (stripeKey) {
      return new StripeGatewayAdapter(stripeKey)
    }
  }

  if (
    razorpayConfigured({
      RAZORPAY_KEY_ID: config.razorpayKeyId,
      RAZORPAY_KEY_SECRET: config.razorpayKeySecret,
    })
  ) {
    return new RazorpayGatewayAdapter(config.razorpayKeyId!, config.razorpayKeySecret!)
  }
  if (config.allowDevCharge) {
    return new DevGatewayAdapter()
  }
  return null
}

