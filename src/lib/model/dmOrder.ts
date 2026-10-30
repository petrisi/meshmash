// Direct message list order: pinned threads in the user's order, then the rest by latest message.

/** `last` gives a peer's latest message time; threads without messages sort first among the unpinned. */
export function orderDms(peers: string[], pins: string[], last: (id: string) => number | undefined): string[] {
  const set = new Set(peers)
  const pinned = pins.filter((id) => set.has(id))
  const isPinned = new Set(pinned)
  const rest = peers
    .filter((id) => !isPinned.has(id))
    .sort((a, b) => (last(b) ?? Number.MAX_SAFE_INTEGER) - (last(a) ?? Number.MAX_SAFE_INTEGER))
  return [...pinned, ...rest]
}

/** Moves a pinned id to position `to` (clamped); unknown ids leave the list unchanged. */
export function movePin(pins: string[], id: string, to: number): string[] {
  const from = pins.indexOf(id)
  if (from < 0) return pins
  const out = pins.filter((x) => x !== id)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, id)
  return out
}
