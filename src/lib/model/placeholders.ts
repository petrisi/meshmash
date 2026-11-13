// Meshtastic nodes added by id: placeholders until the radio reports them.

/** A full node id ("!1234abcd") that can be added, lower-cased; null for anything else. */
export function placeholderId(text: string, selfId: string): string | null {
  const t = text.trim()
  if (!/^![0-9a-f]{8}$/i.test(t)) return null
  const id = t.toLowerCase()
  const num = parseInt(id.slice(1), 16)
  // 0-3 are reserved, 0xffffffff is broadcast.
  if (num <= 3 || num === 0xffffffff || id === selfId.toLowerCase()) return null
  return id
}
