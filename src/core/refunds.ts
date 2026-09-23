import type { PayDeckConfig } from '../config/env'
import type { DatabaseAdapter } from '../db/adapter'
import { getGatewayAdapter } from '../gateways/adapter'
import { paymentResponse } from '../routes/billing'
import type { PaymentRow, RefundRow } from '../types'
import { newId } from '../crypto'
import { logAudit } from './audit'
import { CreateRefundSchema, formatZodError } from './validation'

export interface ExecuteRefundOpts {
  db: DatabaseAdapter
  config: PayDeckConfig
  payment: PaymentRow
  input: unknown
  actor: string
}

export type ExecuteRefundResult =
  | {
      ok: true
      status: 200
      data: {
        ok: true
        refund: RefundRow
        payment: ReturnType<typeof paymentResponse>
      }
    }
  | {
      ok: false
      status: number
      error: string
      detail?: unknown
      details?: Array<{ field: string; message: string }>
    }

export async function executeRefund(opts: ExecuteRefundOpts): Promise<ExecuteRefundResult> {
  const { db, config, payment, input, actor } = opts

  const parsed = CreateRefundSchema.safeParse(input || {})
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      error: 'invalid_refund_input',
      details: formatZodError(parsed.error),
    }
  }
  const body = parsed.data

  if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
    return {
      ok: false,
      status: 400,
      error: 'payment_not_refundable',
      detail: 'Payment must be paid to refund',
    }
  }

  const refundedSum = await db.first<{ total: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0) as total FROM refunds WHERE payment_id = ? AND status = 'processed'`,
    [payment.id],
  )
  const alreadyRefunded = Number(refundedSum?.total ?? 0)
  const remainingRefundable = payment.amount_paise - alreadyRefunded

  if (remainingRefundable <= 0) {
    return { ok: false, status: 400, error: 'payment_already_refunded' }
  }

  const refundAmount = body.amount_paise != null ? body.amount_paise : remainingRefundable
  if (refundAmount > remainingRefundable) {
    return {
      ok: false,
      status: 400,
      error: 'refund_amount_exceeds_payment',
      detail: `Maximum refundable amount is ${remainingRefundable}`,
    }
  }

  const gateway = getGatewayAdapter(config, payment.razorpay_order_id)
  if (!gateway) {
    return { ok: false, status: 503, error: 'gateway_not_configured' }
  }

  const gatewayResult = await gateway.refundPayment({
    paymentId: payment.id,
    razorpayPaymentId: payment.razorpay_payment_id || undefined,
    amountPaise: refundAmount,
    reason: body.reason,
  })

  if (!gatewayResult.ok) {
    return { ok: false, status: 502, error: 'refund_failed', detail: gatewayResult.error }
  }

  const refundId = newId('rfnd')
  const newStatus =
    alreadyRefunded + refundAmount >= payment.amount_paise ? 'refunded' : 'partially_refunded'
  const nowIso = new Date().toISOString()

  await db.transaction(async (tx) => {
    await tx.exec(
      `INSERT INTO refunds (id, payment_id, product_id, amount_paise, gateway_refund_id, reason, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'processed', ?)`,
      [
        refundId,
        payment.id,
        payment.product_id,
        refundAmount,
        gatewayResult.refundId,
        body.reason || null,
        nowIso,
      ],
    )

    await tx.exec(`UPDATE payments SET status = ? WHERE id = ?`, [newStatus, payment.id])
  })

  await logAudit(db, {
    productId: payment.product_id,
    actor,
    action: 'payment.refunded',
    targetId: payment.id,
    details: {
      refund_id: refundId,
      gateway_refund_id: gatewayResult.refundId,
      amount_paise: refundAmount,
      reason: body.reason,
      status: newStatus,
    },
  })

  const updatedPayment = await db.first<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, [
    payment.id,
  ])
  const refundRow = await db.first<RefundRow>(`SELECT * FROM refunds WHERE id = ?`, [refundId])

  return {
    ok: true,
    status: 200,
    data: {
      ok: true,
      refund: refundRow!,
      payment: paymentResponse(updatedPayment!),
    },
  }
}
