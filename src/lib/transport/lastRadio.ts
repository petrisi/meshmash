// The radio we were last connected to, for reconnecting after a USB drop or a page reload.
const KEY = 'meshmash.lastRadio'

export interface LastRadio {
  nodeId: string
  name: string
  vid?: number
  pid?: number
  /** False after the user disconnected on purpose: do not reconnect on reload. */
  auto: boolean
}

export function loadLastRadio(): LastRadio | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}

export function saveLastRadio(r: LastRadio) {
  try {
    localStorage.setItem(KEY, JSON.stringify(r))
  } catch {
    /* storage unavailable */
  }
}

/** Granted ports with the radio's USB ids. Web Serial has no serial numbers, so the
 * caller confirms the node id after connecting. Ports already open are skipped. */
export async function candidatePorts(r: LastRadio): Promise<SerialPort[]> {
  const ports = await navigator.serial.getPorts()
  return ports.filter((p) => {
    const i = p.getInfo()
    return i.usbVendorId === r.vid && i.usbProductId === r.pid && !p.readable
  })
}
