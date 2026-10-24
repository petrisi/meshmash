// Remembers which radio was last found on each granted serial port, so ports that share a
// USB vendor/product id can be told apart. Web Serial exposes no serial number, so ports
// are keyed by their position in getPorts() plus vid:pid — a best-effort label.
const KEY = 'meshmash.portNames'

function load(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
}

async function keyOf(port: SerialPort) {
  const i = (await navigator.serial.getPorts()).indexOf(port)
  const info = port.getInfo()
  return `${i}:${info.usbVendorId ?? ''}:${info.usbProductId ?? ''}`
}

export async function portNames(ports: SerialPort[]): Promise<(string | undefined)[]> {
  const names = load()
  return Promise.all(ports.map(async (p) => names[await keyOf(p)]))
}

export async function rememberPortName(port: SerialPort, name: string) {
  try {
    const names = load()
    names[await keyOf(port)] = name
    localStorage.setItem(KEY, JSON.stringify(names))
  } catch {
    /* storage unavailable */
  }
}
