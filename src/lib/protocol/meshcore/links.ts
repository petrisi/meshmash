// meshcore:// links as used by the official apps (docs.meshcore.io/qr_codes).

export interface ContactLink {
  name: string
  publicKey: string
  type: number
}

export function contactLink(c: ContactLink): string {
  const q = new URLSearchParams({ name: c.name, public_key: c.publicKey.toLowerCase(), type: String(c.type) })
  return `meshcore://contact/add?${q}`
}

/** Parses meshcore://contact/add?name=..&public_key=<64 hex>&type=N; null if not one. */
export function parseContactLink(text: string): ContactLink | null {
  const m = text.trim().match(/^meshcore:\/\/contact\/add\?(.*)$/i)
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const publicKey = (q.get('public_key') ?? '').toLowerCase()
  const type = Number(q.get('type') ?? '1')
  if (!/^[0-9a-f]{64}$/.test(publicKey) || !(type >= 1 && type <= 4)) return null
  return { name: (q.get('name') ?? '').slice(0, 31), publicKey, type }
}
