// Bridge configuration: the radios it may connect to and the pages it accepts.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Protocol = 'meshtastic' | 'meshcore'

export interface RadioConfig {
  name: string
  host: string
  port: number
  protocol: Protocol
}

export interface BridgeConfig {
  port: number
  /** Page origins allowed to connect, besides the bridge's own. */
  origins: string[]
  /** When set, pages must present it (WebSocket subprotocol `token.<value>`). */
  token?: string
  radios: RadioConfig[]
}

export const DEFAULT_PORT = 4404
export const DEFAULT_ORIGINS = ['https://www.simol.in']
/** TCP ports the firmwares listen on. */
export const PROTOCOL_PORT: Record<Protocol, number> = { meshtastic: 4403, meshcore: 5000 }

export function defaultConfig(): BridgeConfig {
  return { port: DEFAULT_PORT, origins: [...DEFAULT_ORIGINS], radios: [] }
}

/** Per-user config file: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config elsewhere. */
export function configPath(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.MESHMASH_BRIDGE_CONFIG) return env.MESHMASH_BRIDGE_CONFIG
  const base =
    platform === 'win32'
      ? (env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'meshmash-bridge', 'config.json')
}

const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u
const HOST = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:]{2,39}\]?$/

function validPort(p: unknown): p is number {
  return Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536
}

/** The protocol defaults from the port, and the port from the protocol. */
export function validRadio(r: { name?: unknown; host?: unknown; port?: unknown; protocol?: unknown }): RadioConfig {
  const name = String(r.name ?? '').trim()
  if (!NAME.test(name)) throw new Error(`radio name "${name}": 1-32 letters, digits, space . _ -, starting with a letter or digit`)
  const host = String(r.host ?? '').trim()
  if (!HOST.test(host)) throw new Error(`radio ${name}: invalid host "${host}"`)
  if (r.port !== undefined && !validPort(r.port)) throw new Error(`radio ${name}: invalid port ${String(r.port)}`)
  let protocol: Protocol
  if (r.protocol === 'meshtastic' || r.protocol === 'meshcore') protocol = r.protocol
  else if (r.protocol !== undefined) throw new Error(`radio ${name}: unknown protocol "${String(r.protocol)}" (meshtastic or meshcore)`)
  else if (r.port === PROTOCOL_PORT.meshtastic) protocol = 'meshtastic'
  else if (r.port === PROTOCOL_PORT.meshcore) protocol = 'meshcore'
  else throw new Error(`radio ${name}: give the protocol (meshtastic or meshcore)`)
  return { name, host: host.replace(/^\[|\]$/g, ''), port: r.port ?? PROTOCOL_PORT[protocol], protocol }
}

export function validConfig(raw: unknown): BridgeConfig {
  if (!raw || typeof raw !== 'object') throw new Error('config is not a JSON object')
  const c = raw as Record<string, unknown>
  const port = c.port ?? DEFAULT_PORT
  if (!validPort(port)) throw new Error(`invalid port ${String(port)}`)
  const origins = c.origins ?? DEFAULT_ORIGINS
  if (!Array.isArray(origins)) throw new Error('origins must be a list')
  for (const o of origins) {
    let u: URL
    try {
      u = new URL(String(o))
    } catch {
      throw new Error(`invalid origin "${o}"`)
    }
    if (u.origin !== o) throw new Error(`origin "${o}" should be "${u.origin}"`)
  }
  if (c.token !== undefined && (typeof c.token !== 'string' || !/^[A-Za-z0-9_-]{16,}$/.test(c.token)))
    throw new Error('token must be at least 16 characters of A-Z a-z 0-9 _ -')
  const radios = (Array.isArray(c.radios) ? c.radios : []).map(validRadio)
  const seen = new Set<string>()
  for (const r of radios) {
    const k = r.name.toLowerCase()
    if (seen.has(k)) throw new Error(`radio name "${r.name}" used twice`)
    seen.add(k)
  }
  return { port, origins: origins.map(String), token: c.token as string | undefined, radios }
}

/** Missing file: the defaults. */
export function loadConfig(path: string): BridgeConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig()
    throw e
  }
  try {
    return validConfig(JSON.parse(text))
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function saveConfig(path: string, c: BridgeConfig) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function newToken(): string {
  return randomBytes(16).toString('base64url')
}

/** "host", "host:port", "[v6]" or "[v6]:port". */
export function parseTarget(s: string): { host: string; port?: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s)
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : undefined }
  const i = s.lastIndexOf(':')
  if (i > 0 && s.indexOf(':') === i) return { host: s.slice(0, i), port: Number(s.slice(i + 1)) }
  return { host: s }
}
