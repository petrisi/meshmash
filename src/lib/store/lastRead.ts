// Per-radio read positions per thread, so unread counts survive a reload.
const key = (radio: string) => `meshmash.lastRead.${radio}`

export function loadLastRead(radio: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key(radio)) ?? '{}')
  } catch {
    return {}
  }
}

export function saveLastRead(radio: string, lastRead: Record<string, number>) {
  try {
    localStorage.setItem(key(radio), JSON.stringify(lastRead))
  } catch {
    /* storage unavailable */
  }
}
