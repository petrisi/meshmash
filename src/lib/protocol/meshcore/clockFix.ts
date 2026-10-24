// MeshCore radios without an RTC can run on a wrong clock for weeks, and stamp contacts with
// it. When we correct a clock we remember by how much, so timestamps stored before the
// correction can be read in real time.
const KEY = 'meshmash.clockFixes'

export interface ClockFix {
  /** Unix seconds (correct time) when the clock was set. */
  at: number
  /** Seconds added to the radio clock. */
  skew: number
}

function load(): Record<string, ClockFix[]> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function clockFixes(radio: string): ClockFix[] {
  return load()[radio] ?? []
}

export function recordClockFix(radio: string, fix: ClockFix) {
  try {
    const all = load()
    all[radio] = [...(all[radio] ?? []), fix].slice(-10)
    globalThis.localStorage?.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable */
  }
}

/**
 * Radio-clock seconds → real unix seconds. A value stored before a forward correction lies
 * at least `skew` before the correction time in radio time; halfway is the cut-off.
 */
export function correctRadioSecs(secs: number, fixes: ClockFix[]): number {
  // The earliest correction made after the value was stored tells which era it is from.
  const f = fixes.find((f) => f.skew > 0 && secs < f.at - f.skew / 2)
  return f ? secs + f.skew : secs
}
