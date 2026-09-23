import { z } from 'zod'
import { CurrencySchema } from '../schemas'

export const CreateOrderSchema = z
  .object({
    plan: z.string().trim().lowercase().optional(),
    amount_paise: z.number().int().min(100, 'Minimum 100 paise (₹1)').optional(),
    currency: CurrencySchema.default('INR'),
    receipt: z.string().trim().max(40, 'Receipt maximum 40 characters').optional(),
    notes: z.record(z.string(), z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    description: z.string().optional(),
    customer_id: z.string().trim().optional(),
  })
  .refine((data) => data.plan || data.amount_paise != null, {
    message: 'Either plan or amount_paise is required',
  })

export const VerifyRequestSchema = z.object({
  razorpay_order_id: z.string().trim().min(1, 'razorpay_order_id is required'),
  razorpay_payment_id: z.string().trim().min(1, 'razorpay_payment_id is required'),
  razorpay_signature: z.string().trim().min(1, 'razorpay_signature is required'),
})

export const CreateProductSchema = z.object({
  slug: z
    .string()
    .trim()
    .lowercase()
    .regex(/^[a-z0-9][a-z0-9_-]{1,63}$/, 'Invalid product slug format'),
  name: z.string().trim().min(1, 'Name is required'),
  rate_limit_per_hour: z.number().int().min(1).max(100000).default(200),
})

export const CreatePlanSchema = z.object({
  slug: z
    .string()
    .trim()
    .lowercase()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Invalid plan slug format'),
  name: z.string().trim().min(1, 'Name is required'),
  amount_paise: z.number().int().min(100, 'Minimum 100 paise (₹1)'),
  currency: CurrencySchema.default('INR'),
  interval: z.enum(['month', 'year', 'one_time']),
})

export const CreateKeySchema = z.object({
  name: z.string().trim().optional(),
  environment: z.enum(['live', 'test']).default('live'),
})

export { CreateCustomerSchema, CreateRefundSchema, CurrencySchema } from '../schemas'


export function formatZodError(error: z.ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.join('.'),
    message: issue.message,
  }))
}

export function errorEnvelope(
  requestId: string,
  error: string,
  code: string,
  message: string,
  details?: Array<{ field: string; message: string }>,
) {
  return {
    error,
    code,
    message,
    request_id: requestId,
    ...(details && details.length > 0 ? { details } : {}),
  }
}
