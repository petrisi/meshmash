// MeshCore flood scopes (regions): a flood packet carries a transport code derived from a region
// key, and repeaters flood it on only for regions they allow. Public regions: the key is the
// first 16 bytes of SHA-256("#" + name), as in the firmware's TransportKeyStore::getAutoKeyFor.

/** Longest region name the firmware stores (char[31] with the terminating NUL). */
export const SCOPE_NAME_MAX_BYTES = 30

/**
 * A region name as the firmware accepts it (RegionMap::is_name_char): '-', digits, and bytes
 * from 'A' up (letters, a few punctuation marks, non-ASCII). A leading '#' is dropped; private
 * ('$') regions have no derivable key and are not accepted. Null when not valid.
 */
export function scopeName(text: string): string | null {
  const name = text.trim().replace(/^#/, '')
  const bytes = new TextEncoder().encode(name)
  if (!bytes.length || bytes.length > SCOPE_NAME_MAX_BYTES) return null
  for (const c of bytes) if (!(c === 0x2d || (c >= 0x30 && c <= 0x39) || c >= 0x41)) return null
  return name
}

/** The 16-byte key of a public region. */
export async function scopeKey(name: string): Promise<Uint8Array> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`#${name}`))
  return new Uint8Array(d, 0, 16)
}

/**
 * Transport code of a packet under a region key (TransportKey::calcTransportCode): the first
 * two bytes of HMAC-SHA256(key, [payload type][payload]), little-endian; 0000 and FFFF are reserved.
 */
export async function transportCode(key: Uint8Array, payloadType: number, payload: Uint8Array): Promise<number> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const data = new Uint8Array(1 + payload.length)
  data[0] = payloadType
  data.set(payload, 1)
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, data))
  const code = mac[0] | (mac[1] << 8)
  return code === 0 ? 1 : code === 0xffff ? 0xfffe : code
}
