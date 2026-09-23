import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Security Headers Middleware', () => {
  it('includes security headers in API responses', async () => {
    const res = await app.request('/v1/openapi.json')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    expect(res.headers.get('Strict-Transport-Security')).toContain('includeSubDomains')
  })

  it('includes security headers on health endpoint', async () => {
    const res = await app.request('/health')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains')
  })

  it('includes CORS headers for incoming requests', async () => {
    const res = await app.request('/health', {
      headers: {
        Origin: 'https://example.com',
      },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy()
  })
})
