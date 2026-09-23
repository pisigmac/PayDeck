import { describe, expect, it, vi } from 'vitest'
import { cancelSubscription, createSubscription } from '../src/core/subscriptions'
import { startWebhookWorker } from '../src/core/webhook-worker'
import { enqueueWebhookDelivery, processWebhookDeliveries } from '../src/core/webhook-queue'
import { SQLiteAdapter } from '../src/db/sqlite'

async function setupTestDb() {
  const db = new SQLiteAdapter(':memory:')
  await db.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rate_limit_per_hour INTEGER NOT NULL DEFAULT 200,
      active INTEGER NOT NULL DEFAULT 1,
      webhook_url TEXT,
      webhook_secret TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE TABLE customers (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      external_user_id TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE plans (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      interval TEXT NOT NULL DEFAULT 'monthly',
      created_at TEXT NOT NULL
    );

    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (plan_id) REFERENCES plans(id)
    );

    CREATE INDEX subscriptions_customer_idx ON subscriptions(customer_id);
    CREATE INDEX subscriptions_status_idx ON subscriptions(status, current_period_end);

    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE admin_users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL
    );
  `)

  await db.exec(`
    INSERT INTO products (id, slug, name, webhook_secret)
    VALUES ('prod_1', 'acme', 'Acme Corp', 'secret_wh_123');

    INSERT INTO customers (id, product_id, email, name, created_at)
    VALUES ('cust_1', 'prod_1', 'cust@example.com', 'John Doe', '2026-08-24T10:00:00Z');

    INSERT INTO plans (id, product_id, name, amount, currency, interval, created_at)
    VALUES ('plan_1', 'prod_1', 'Pro Plan', 99900, 'INR', 'monthly', '2026-08-24T10:00:00Z');
  `)

  return db
}

describe('Subscriptions Domain Engine', () => {
  it('creates and cancels subscriptions (immediately)', async () => {
    const db = await setupTestDb()

    const sub = await createSubscription(db, {
      productId: 'prod_1',
      customerId: 'cust_1',
      planId: 'plan_1',
      periodDays: 30,
    })

    expect(sub.id).toBeDefined()
    expect(sub.id).toMatch(/^sub_/)
    expect(sub.status).toBe('active')
    expect(sub.productId).toBe('prod_1')
    expect(sub.customerId).toBe('cust_1')
    expect(sub.planId).toBe('plan_1')
    expect(sub.cancel_at_period_end).toBe(0)

    const row = await db.first<{ id: string; status: string }>(
      `SELECT id, status FROM subscriptions WHERE id = ?`,
      [sub.id],
    )
    expect(row?.status).toBe('active')

    const canceled = await cancelSubscription(db, sub.id, true)
    expect(canceled.status).toBe('canceled')

    const rowAfter = await db.first<{ id: string; status: string }>(
      `SELECT id, status FROM subscriptions WHERE id = ?`,
      [sub.id],
    )
    expect(rowAfter?.status).toBe('canceled')
  })

  it('cancels subscription at period end when immediately = false', async () => {
    const db = await setupTestDb()

    const sub = await createSubscription(db, {
      productId: 'prod_1',
      customerId: 'cust_1',
      planId: 'plan_1',
    })

    const updated = await cancelSubscription(db, sub.id, false)
    expect(updated.status).toBe('active')

    const row = await db.first<{ cancel_at_period_end: number; status: string }>(
      `SELECT cancel_at_period_end, status FROM subscriptions WHERE id = ?`,
      [sub.id],
    )
    expect(row?.cancel_at_period_end).toBe(1)
    expect(row?.status).toBe('active')
  })
})

describe('Webhook Worker', () => {
  it('starts background webhook worker loop and processes deliveries', async () => {
    const db = await setupTestDb()

    await enqueueWebhookDelivery(db, {
      productId: 'prod_1',
      event: 'subscription.created',
      payload: { sub_id: 'sub_123' },
      url: 'https://example.com/worker-webhook',
    })

    const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }))

    const stopWorker = startWebhookWorker(db, 20, mockFetch as typeof fetch)
    await processWebhookDeliveries(db, mockFetch as typeof fetch)

    // Wait short time for worker interval to fire
    await new Promise((resolve) => setTimeout(resolve, 60))

    stopWorker()

    expect(mockFetch).toHaveBeenCalled()

    const delivery = await db.first<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM webhook_deliveries LIMIT 1`,
    )
    expect(delivery?.status).toBe('delivered')
    expect(delivery?.attempts).toBe(1)
  })
})
