import { newId } from '../crypto'
import type {
  CreateOrderOpts,
  PaymentGatewayAdapter,
  RefundOpts,
  VerifyPaymentOpts,
} from './adapter'

export class DevGatewayAdapter implements PaymentGatewayAdapter {
  name = 'dev'

  async createOrder(opts: CreateOrderOpts) {
    const orderId = `order_dev_${newId('ord').slice(-16)}`
    return { ok: true as const, orderId, raw: { id: orderId, amount: opts.amountPaise } }
  }

  async verifyPayment(opts: VerifyPaymentOpts) {
    return opts.signature === 'dev' || opts.orderId.startsWith('order_dev_')
  }

  async refundPayment(opts: RefundOpts) {
    const refundId = `rfnd_dev_${newId('rfnd').slice(-16)}`
    return { ok: true as const, refundId, raw: { id: refundId, amount: opts.amountPaise } }
  }
}
