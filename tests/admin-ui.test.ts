import { describe, expect, it } from 'vitest'
import app from '../src/index'

describe('Web Admin Dashboard UI Static Asset Serving', () => {
  it('serves admin dashboard HTML at /admin', async () => {
    const res = await app.request('/admin')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PayDeck')
    expect(html).toContain('Products & Plans')
    expect(html).toContain('API Keys')
    expect(html).toContain('Customers & Subscriptions')
    expect(html).toContain('Payments & Refunds')
    expect(html).toContain('Audit Logs')
    expect(html).toContain('Webhook Deliveries')
  })

  it('serves admin dashboard HTML at /admin/', async () => {
    const res = await app.request('/admin/')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PayDeck')
  })

  it('serves admin dashboard HTML at /admin/index.html', async () => {
    const res = await app.request('/admin/index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PayDeck')
  })

  it('serves admin dashboard HTML at /public/admin/index.html', async () => {
    const res = await app.request('/public/admin/index.html')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('PayDeck')
  })
})
