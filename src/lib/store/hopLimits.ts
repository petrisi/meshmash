// Per-radio hop limit chosen for a DM thread, kept until changed.
import type { ThreadKey } from '../model/types'

const key = (radio: string) => `meshmash.hopLimits.${radio}`

function load(radio: string): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(key(radio)) ?? '{}')
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export function loadHopLimit(radio: string, thread: ThreadKey): number | null {
  const v = load(radio)[thread]
  return Number.isInteger(v) && v >= 0 && v <= 7 ? v : null
}

/** null clears the thread's choice (back to the radio default). */
export function saveHopLimit(radio: string, thread: ThreadKey, hops: number | null) {
  const all = load(radio)
  if (hops === null) delete all[thread]
  else all[thread] = hops
  try {
    localStorage.setItem(key(radio), JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}
