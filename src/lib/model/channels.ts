// Channel editing: name limits, keys, and when an edit makes a different channel.
import type { ChannelConfig, Protocol } from './types'

/** Name bytes the firmware stores: Meshtastic name is char[12], MeshCore char[32]; both NUL-terminated. */
export const NAME_MAX_BYTES: Record<Protocol, number> = { meshtastic: 11, meshcore: 31 }

export const utf8Length = (s: string) => new TextEncoder().encode(s).length

export function randomKey(bytes: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes))
}

export const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/** A pasted key, hex or base64 (standard or URL-safe), if it decodes to one of `lengths` bytes. */
export function parseKey(text: string, lengths: number[]): Uint8Array | undefined {
  const t = text.trim()
  if (/^([0-9a-f]{2})+$/i.test(t)) {
    const b = Uint8Array.from(t.match(/../g)!, (h) => parseInt(h, 16))
    if (lengths.includes(b.length)) return b
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(t)) {
    try {
      const bin = atob(t.replace(/-/g, '+').replace(/_/g, '/'))
      const b = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      if (lengths.includes(b.length)) return b
    } catch {
      /* not base64 */
    }
  }
  return undefined
}

export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/**
 * Whether saving `next` over `old` makes a different channel, so its history no longer
 * applies. Meshtastic identifies a channel by name and key, MeshCore by key alone.
 */
export function channelReplaced(protocol: Protocol, old: ChannelConfig | undefined, next: ChannelConfig): boolean {
  if (!old) return true
  if (!sameBytes(old.key, next.key)) return true
  return protocol === 'meshtastic' && old.name !== next.name
}
