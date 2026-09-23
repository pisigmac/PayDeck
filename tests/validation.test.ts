import { describe, expect, it } from 'vitest'
import {
  CreateOrderSchema,
  VerifyRequestSchema,
  CreateProductSchema,
  CreatePlanSchema,
  CreateKeySchema,
  formatZodError,
  errorEnvelope,
} from '../src/core/validation'

describe('Zod Validation Schemas', () => {
  it('validates CreateOrderSchema', () => {
    const validWithAmount = CreateOrderSchema.safeParse({ amount_paise: 500, currency: 'INR' })
    expect(validWithAmount.success).toBe(true)

    const validWithPlan = CreateOrderSchema.safeParse({ plan: 'pro' })
    expect(validWithPlan.success).toBe(true)

    const invalidAmount = CreateOrderSchema.safeParse({ amount_paise: 50 })
    expect(invalidAmount.success).toBe(false)

    const invalidNeither = CreateOrderSchema.safeParse({ description: 'test' })
    expect(invalidNeither.success).toBe(false)
  })

  it('validates VerifyRequestSchema', () => {
    const valid = VerifyRequestSchema.safeParse({
      razorpay_order_id: 'order_123',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'sig_123',
    })
    expect(valid.success).toBe(true)

    const invalid = VerifyRequestSchema.safeParse({
      razorpay_order_id: '',
      razorpay_payment_id: 'pay_123',
      razorpay_signature: 'sig_123',
    })
    expect(invalid.success).toBe(false)
  })

  it('validates CreateProductSchema', () => {
    const valid = CreateProductSchema.safeParse({ slug: 'form-relay_1', name: 'FormRelay' })
    expect(valid.success).toBe(true)

    const invalid = CreateProductSchema.safeParse({ slug: 'Invalid Slug!', name: '' })
    expect(invalid.success).toBe(false)
  })

  it('validates CreatePlanSchema', () => {
    const valid = CreatePlanSchema.safeParse({
      slug: 'pro',
      name: 'Pro Plan',
      amount_paise: 1000,
      interval: 'month',
    })
    expect(valid.success).toBe(true)

    const invalid = CreatePlanSchema.safeParse({ slug: 'pro', amount_paise: 50, interval: 'invalid' })
    expect(invalid.success).toBe(false)
  })

  it('validates CreateKeySchema', () => {
    const valid = CreateKeySchema.safeParse({ name: 'Default Key', environment: 'live' })
    expect(valid.success).toBe(true)

    const validDefault = CreateKeySchema.safeParse({})
    expect(validDefault.success).toBe(true)
    if (validDefault.success) {
      expect(validDefault.data.environment).toBe('live')
    }

    const invalid = CreateKeySchema.safeParse({ environment: 'invalid_env' })
    expect(invalid.success).toBe(false)
  })

  it('formats Zod errors into structured details', () => {
    const res = CreatePlanSchema.safeParse({ slug: 'pro', amount_paise: 50, interval: 'invalid' })
    expect(res.success).toBe(false)
    if (!res.success) {
      const formatted = formatZodError(res.error)
      expect(formatted.length).toBeGreaterThan(0)
      expect(formatted[0]).toHaveProperty('field')
      expect(formatted[0]).toHaveProperty('message')
    }
  })

  it('formats standard error envelope', () => {
    const envelope = errorEnvelope(
      'req_12345',
      'invalid_request',
      'VALIDATION_FAILED',
      'Invalid payload',
      [{ field: 'amount_paise', message: 'Minimum 100 paise' }],
    )

    expect(envelope).toEqual({
      error: 'invalid_request',
      code: 'VALIDATION_FAILED',
      message: 'Invalid payload',
      request_id: 'req_12345',
      details: [{ field: 'amount_paise', message: 'Minimum 100 paise' }],
    })
  })
})
