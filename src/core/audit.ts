import { newId } from '../crypto'
import type { DatabaseAdapter } from '../db/adapter'

export interface LogAuditOptions {
  productId?: string | null
  actor: string
  action: string
  targetId: string
  details?: Record<string, unknown> | string | null
}

export async function logAudit(
  db: DatabaseAdapter,
  opts: LogAuditOptions,
): Promise<void> {
  const id = newId('audit')
  const nowIso = new Date().toISOString()
  const detailsStr =
    opts.details == null
      ? null
      : typeof opts.details === 'string'
        ? opts.details
        : JSON.stringify(opts.details)

  await db.exec(
    `INSERT INTO audit_logs (id, product_id, actor, action, target_id, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.productId || null,
      opts.actor,
      opts.action,
      opts.targetId,
      detailsStr,
      nowIso,
    ],
  )
}
