import { z } from 'zod'

export const CurrencySchema = z.string().trim().length(3).toUpperCase()

export const CreateCustomerSchema = z.object({
  email: z.string().trim().email('Invalid email address').optional(),
  name: z.string().trim().optional(),
  external_user_id: z.string().trim().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const CreateRefundSchema = z.object({
  amount_paise: z.number().int().min(1).optional(),
  reason: z.string().trim().optional(),
})
