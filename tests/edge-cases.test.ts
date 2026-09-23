import { describe, expect, it } from 'vitest'
import app from '../src/index'
import { SQLiteAdapter } from '../src/db/sqlite'
import { assertWithinRateLimit } from '../src/policy'
import { formatZodError, errorEnvelope } from '../src/core/validation'
import { z } from 'zod'

describe('Edge Cases & Robustness Test Suite', () => {
  it('handles empty and whitespace-only authorization headers', async () => {
    const res = await app.request('/v1/plans', {
      headers: { Authorization: '  ' },
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const json = await res.json()
    expect(json).toHaveProperty('error')
  })

  it('formats complex nested Zod validation errors safely', () => {
    const DummySchema = z.object({
      user: z.object({
        email: z.string().email(),
        age: z.number().min(18),
      }),
    })

    const result = DummySchema.safeParse({ user: { email: 'not-an-email', age: 10 } })
    expect(result.success).toBe(false)
    if (!result.success) {
      const formatted = formatZodError(result.error)
      expect(formatted.length).toBe(2)
      expect(formatted[0]?.field).toBe('user.email')
      expect(formatted[1]?.field).toBe('user.age')
    }
  })

  it('constructs robust error envelopes with and without details', () => {
    const env1 = errorEnvelope('req_123', 'invalid_request', 'BAD_PARAMS', 'Error message')
    expect(env1.error).toBe('invalid_request')
    expect(env1.code).toBe('BAD_PARAMS')
    expect(env1.request_id).toBe('req_123')
    expect(env1.details).toBeUndefined()

    const env2 = errorEnvelope('req_123', 'invalid_request', 'BAD_PARAMS', 'Error message', [
      { field: 'amount', message: 'Too small' },
    ])
    expect(env2.details).toHaveLength(1)
  })

  it('handles rate-limit bucket resets at hour boundary', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.exec(`
      CREATE TABLE rate_buckets (
        product_id TEXT NOT NULL,
        hour_bucket TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, hour_bucket)
      );
    `)

    const product = {
      id: 'prod_test',
      slug: 'test',
      name: 'Test',
      rate_limit_per_hour: 2,
      active: 1,
      created_at: new Date().toISOString(),
    }

    const check1 = await assertWithinRateLimit(db, product)
    expect(check1.ok).toBe(true)
    expect(check1.remaining).toBe(1)

    const check2 = await assertWithinRateLimit(db, product)
    expect(check2.ok).toBe(true)
    expect(check2.remaining).toBe(0)

    const check3 = await assertWithinRateLimit(db, product)
    expect(check3.ok).toBe(false)
    expect(check3.remaining).toBe(0)
    expect(check3.resetSeconds).toBeGreaterThan(0)
  })
})
