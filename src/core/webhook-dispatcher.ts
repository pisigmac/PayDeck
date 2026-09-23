import { hmacSha256Hex } from '../crypto'

export interface DispatchWebhookOpts {
  webhookUrl: string
  webhookSecret?: string | null
  event: string
  data: Record<string, unknown>
}

export async function dispatchDownstreamWebhook(
  opts: DispatchWebhookOpts,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!opts.webhookUrl) return { ok: false, error: 'no_webhook_url' }

  const payload = JSON.stringify({
    event: opts.event,
    timestamp: new Date().toISOString(),
    data: opts.data,
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-PayDeck-Event': opts.event,
  }

  if (opts.webhookSecret) {
    const sig = await hmacSha256Hex(opts.webhookSecret, payload)
    headers['X-PayDeck-Signature'] = sig
  }

  try {
    const res = await fetchFn(opts.webhookUrl, {
      method: 'POST',
      headers,
      body: payload,
    })
    return { ok: res.ok, status: res.status }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
