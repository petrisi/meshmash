// Per-radio direct message list: pinned threads in order, and when threads were closed by the user.
const key = (radio: string) => `meshmash.dmList.${radio}`

export interface DmList {
  pins: string[]
  /** Peer id → time closed; a later message reopens the thread. */
  closed: Record<string, number>
}

export function loadDmList(radio: string): DmList {
  try {
    const v = JSON.parse(localStorage.getItem(key(radio)) ?? '{}')
    const pins = Array.isArray(v?.pins) ? [...new Set<string>(v.pins.filter((x: unknown) => typeof x === 'string'))] : []
    const closed = Object.fromEntries(
      Object.entries(v?.closed && typeof v.closed === 'object' ? v.closed : {}).filter(([, ts]) => Number.isFinite(ts)),
    ) as Record<string, number>
    return { pins, closed }
  } catch {
    return { pins: [], closed: {} }
  }
}

export function saveDmList(radio: string, list: DmList) {
  try {
    localStorage.setItem(key(radio), JSON.stringify(list))
  } catch {
    /* storage unavailable */
  }
}
