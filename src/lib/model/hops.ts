/** Meshtastic packet headers hold the hop limit in 3 bits. */
export const MAX_HOPS = 7

/**
 * Hop limit to suggest when the other side was heard further away than `limit`.
 * A node `hops` away needs a hop limit of at least `hops` to be reached.
 */
export function hopSuggestion(limit: number, hops: number | undefined): number | undefined {
  if (hops === undefined || hops <= limit) return undefined
  return Math.min(MAX_HOPS, hops)
}
