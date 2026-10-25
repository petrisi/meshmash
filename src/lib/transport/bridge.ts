// WebSocket to meshmash-bridge, a local program that relays bytes to radios on WiFi.
// Protocol: docs/wifi-bridge.md.
import type { Protocol } from '../model/types'
import type { Transport } from './types'

export const DEFAULT_BRIDGE = '127.0.0.1:4404'
const KEY = 'meshmash.bridge'
const SUBPROTOCOL = 'meshmash.v1'
/** The bridge only listens on loopback; a pairing link cannot point anywhere else. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/

export interface BridgeSettings {
  address: string
  token?: string
}

export interface BridgeRadio {
  name: string
  protocol: Protocol
  inUse: boolean
}

export interface BridgeHello {
  version: string
  radios: BridgeRadio[]
}

/** What the browser is doing while the socket is still connecting. */
export type BridgeWait = 'prompt' | 'connecting'

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
  }
}

export function loadBridge(): BridgeSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (v && LOOPBACK.test(v.address)) return { address: v.address, token: typeof v.token === 'string' ? v.token : undefined }
  } catch {
    /* fall through */
  }
  return { address: DEFAULT_BRIDGE }
}

export function saveBridge(s: BridgeSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* storage unavailable */
  }
}

/**
 * The bridge prints a link ending in #bridge=127.0.0.1:4404&token=… when it is not on the
 * default port or requires a token. Stores it and removes it from the address bar.
 */
export function takePairing(): boolean {
  const p = new URLSearchParams(location.hash.slice(1))
  const address = p.get('bridge')
  if (!address) return false
  history.replaceState(null, '', location.pathname + location.search)
  if (!LOOPBACK.test(address)) return false
  const token = p.get('token')
  saveBridge({ address, token: token && /^[A-Za-z0-9_-]{16,}$/.test(token) ? token : undefined })
  return true
}

/** Text for the bridge's close codes, naming the radio when known. */
function closeText(code: number, radio = 'The radio'): string | undefined {
  switch (code) {
    case 4400:
      return 'The bridge did not understand this page; update meshmash-bridge'
    case 4401:
      return 'The bridge requires a token: open the pairing link it prints'
    case 4404:
      return `The bridge has no radio named "${radio}"`
    case 4409:
      return `${radio} is in use by another meshmash window`
    case 4410:
      return `Another meshmash window took over ${radio}`
  }
}

/** Chromium asks before a public page may reach loopback (Local Network Access). */
async function loopbackPermission(): Promise<PermissionState | undefined> {
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      return (await navigator.permissions.query({ name } as unknown as PermissionDescriptor)).state
    } catch {
      /* unknown permission name in this browser */
    }
  }
  return undefined
}

async function notReached(address: string): Promise<BridgeError> {
  if ((await loopbackPermission()) === 'denied')
    return new BridgeError('This site is not allowed to reach the bridge. Allow "Local network access" in the site settings (icon left of the address).')
  return new BridgeError(`No bridge answering at ${address}. Is meshmash-bridge running?`)
}

/** Opens a socket and waits for the bridge's hello. */
function handshake(s: BridgeSettings, onWait?: (w: BridgeWait) => void): Promise<{ ws: WebSocket; hello: BridgeHello }> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket
    try {
      ws = new WebSocket(`ws://${s.address}/v1`, [SUBPROTOCOL, ...(s.token ? [`token.${s.token}`] : [])])
    } catch (e) {
      return reject(new BridgeError(e instanceof Error ? e.message : String(e)))
    }
    ws.binaryType = 'arraybuffer'
    // A pending Local Network Access prompt holds the socket in CONNECTING.
    const slow = setTimeout(
      () => void loopbackPermission().then((p) => ws.readyState === WebSocket.CONNECTING && onWait?.(p === 'prompt' ? 'prompt' : 'connecting')),
      1500,
    )
    const done = () => {
      clearTimeout(slow)
      ws.onmessage = ws.onclose = ws.onerror = null
    }
    ws.onerror = () => {} // the close event follows
    ws.onclose = (e) => {
      done()
      const text = closeText(e.code)
      if (text) reject(new BridgeError(text, e.code))
      else void notReached(s.address).then(reject)
    }
    ws.onmessage = (e) => {
      done()
      try {
        const m = JSON.parse(String(e.data))
        if (m.t !== 'hello' || !Array.isArray(m.radios)) throw new Error()
        const radios = (m.radios as BridgeRadio[]).filter(
          (r) => typeof r.name === 'string' && (r.protocol === 'meshtastic' || r.protocol === 'meshcore'),
        )
        resolve({ ws, hello: { version: String(m.bridge), radios } })
      } catch {
        ws.close()
        reject(new BridgeError('Unexpected answer from the bridge'))
      }
    }
  })
}

/** The bridge's radios. */
export async function listRadios(s: BridgeSettings, onWait?: (w: BridgeWait) => void): Promise<BridgeHello> {
  const { ws, hello } = await handshake(s, onWait)
  ws.close(1000)
  return hello
}

/** Opens a radio through the bridge; resolves once the bridge has its TCP connection. */
export async function openBridgeRadio(
  s: BridgeSettings,
  radio: string,
  opts: { takeover?: boolean; onWait?: (w: BridgeWait) => void } = {},
): Promise<{ transport: BridgeTransport; protocol: Protocol }> {
  const { ws } = await handshake(s, opts.onWait)
  return new Promise((resolve, reject) => {
    let reason = ''
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return
      try {
        const m = JSON.parse(e.data)
        if (m.t === 'closed') reason = String(m.reason ?? '')
        if (m.t !== 'opened') return
        const transport = new BridgeTransport(ws, radio)
        resolve({ transport, protocol: m.protocol === 'meshcore' ? 'meshcore' : 'meshtastic' })
      } catch {
        ws.close()
      }
    }
    ws.onclose = (e) => reject(new BridgeError(reason || closeText(e.code, radio) || 'The bridge closed the connection', e.code))
    ws.send(JSON.stringify({ t: 'open', radio, takeover: !!opts.takeover }))
  })
}

export class BridgeTransport implements Transport {
  onData: (chunk: Uint8Array) => void = () => {}
  onClose: (reason?: string) => void = () => {}
  final = false
  private closing = false

  readonly label: string

  constructor(
    private ws: WebSocket,
    readonly radio: string,
  ) {
    this.label = `WiFi ${radio}`
    let reason = ''
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.onData(new Uint8Array(e.data))
      else
        try {
          const m = JSON.parse(String(e.data))
          if (m.t === 'closed') reason = String(m.reason ?? '')
        } catch {
          /* ignore */
        }
    }
    ws.onclose = (e) => {
      if (this.closing) return this.onClose()
      this.closing = true
      this.final = e.code === 4410
      this.onClose(reason || closeText(e.code, this.radio) || 'bridge connection lost')
    }
  }

  async write(bytes: Uint8Array) {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('bridge connection closed')
    this.ws.send(bytes as Uint8Array<ArrayBuffer>)
  }

  async close() {
    if (this.closing) return
    this.closing = true
    if (this.ws.readyState === WebSocket.CLOSED) return this.onClose()
    this.ws.close(1000)
  }
}
