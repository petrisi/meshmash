// Meshtastic relay_node: the last byte of the node whose transmission our radio heard.
import { distanceKm } from '../format'
import type { MeshNode } from './types'

/** Last byte of a Meshtastic "!hex" node id as sent in relay_node (0 is sent as 0xff). */
export function relayByte(id: string): number | undefined {
  if (!/^![0-9a-f]{8}$/.test(id)) return undefined
  return parseInt(id.slice(-2), 16) || 0xff
}

export interface RelayGuess {
  /** Short names, closest first; empty when no known node matches. */
  names: string[]
  /** Matches beyond the names shown. */
  more: number
  /** No node heard directly matches; the names are guesses among farther nodes. */
  likely: boolean
  /** The byte as hex, shown when no node matches. */
  hex: string
}

const SHOWN = 3

/**
 * Candidates for a relay byte: nodes heard directly first, then any known node.
 * Ordered by distance from `self` when both positions are known, then by last heard.
 */
export function guessRelay(byte: number, nodes: Iterable<MeshNode>, self?: MeshNode, exclude?: string): RelayGuess {
  const matches = [...nodes].filter((n) => n.id !== self?.id && n.id !== exclude && relayByte(n.id) === byte)
  const direct = matches.filter((n) => n.hops === 0)
  const pool = direct.length ? direct : matches
  const dist = (n: MeshNode) => distanceKm(self?.position, n.position) ?? Infinity
  pool.sort((a, b) => dist(a) - dist(b) || (b.lastHeard ?? 0) - (a.lastHeard ?? 0))
  return {
    names: pool.slice(0, SHOWN).map((n) => n.shortName || n.id),
    more: Math.max(0, pool.length - SHOWN),
    likely: !direct.length && pool.length > 0,
    hex: byte.toString(16).padStart(2, '0'),
  }
}

/** "zeb3", "zeb3 or koik", "zeb3, koik or zen4 +2 more", or the byte. */
export function relayNames(g: RelayGuess): string {
  const n = g.names
  if (!n.length) return g.hex
  const list = n.length === 1 ? n[0] : `${n.slice(0, -1).join(', ')} or ${n.at(-1)}`
  return g.more ? `${list} +${g.more} more` : list
}
