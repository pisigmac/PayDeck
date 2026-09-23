import type { DatabaseAdapter } from '../db/adapter'
import { processWebhookDeliveries } from './webhook-queue'

export function startWebhookWorker(
  db: DatabaseAdapter,
  intervalMs = 60000,
  fetchFn: typeof fetch = fetch,
) {
  const timer = setInterval(async () => {
    try {
      await processWebhookDeliveries(db, fetchFn)
    } catch (e) {
      console.warn('Webhook worker error:', e)
    }
  }, intervalMs)

  return () => clearInterval(timer)
}
