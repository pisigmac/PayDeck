function toBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBytes(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    toBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, toBytes(payload))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}_${hex}`
}

/** Generate pd_live_… / pd_test_… secret + hash + prefix for storage. */
export async function mintApiKey(environment: 'live' | 'test'): Promise<{
  raw: string
  hash: string
  prefix: string
}> {
  const rand = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const raw = `pd_${environment}_${rand}`
  const hash = await sha256Hex(raw)
  const prefix = raw.slice(0, 14)
  return { raw, hash, prefix }
}

export function parseBearer(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1]!.trim() : null
}
