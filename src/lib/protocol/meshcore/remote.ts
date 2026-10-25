// Requests to other nodes: login, status, telemetry, binary requests, trace, CLI.
// Layouts: docs/meshcore/repeaters-and-rooms.md, telemetry.md, paths-and-trace.md, cli-over-lora.md.
import { hex, LeReader, LeWriter, utf8Encode } from '../bytes'
import { Cmd, TxtType } from './codec'

export const RemoteCmd = {
  SEND_LOGIN: 26,
  SEND_STATUS_REQ: Cmd.SEND_STATUS_REQ,
  SEND_TRACE_PATH: Cmd.SEND_TRACE_PATH,
  SEND_TELEMETRY_REQ: Cmd.SEND_TELEMETRY_REQ,
  SEND_BINARY_REQ: 50,
} as const

export const ReqType = { GET_NEIGHBOURS: 0x06, GET_OWNER_INFO: 0x07 } as const

/** Only the first 15 password bytes are used by the firmware. */
export const cmdLogin = (pk: Uint8Array, password: string) =>
  new LeWriter().u8(RemoteCmd.SEND_LOGIN).bytes(pk).bytes(utf8Encode(password).subarray(0, 15)).finish()

export const cmdStatusReq = (pk: Uint8Array) => new LeWriter().u8(RemoteCmd.SEND_STATUS_REQ).bytes(pk).finish()

export const cmdTelemetryReq = (pk: Uint8Array) =>
  new LeWriter().u8(RemoteCmd.SEND_TELEMETRY_REQ).u8(0).u8(0).u8(0).bytes(pk).finish()

export const cmdBinaryReq = (pk: Uint8Array, data: Uint8Array) =>
  new LeWriter().u8(RemoteCmd.SEND_BINARY_REQ).bytes(pk).bytes(data).finish()

export const NEIGHBOUR_PREFIX = 6
/** At most floor(130 / (prefix + 5)) entries fit one reply. */
export const NEIGHBOURS_PER_PAGE = Math.floor(130 / (NEIGHBOUR_PREFIX + 5))

export const neighboursReq = (offset: number) =>
  new LeWriter()
    .u8(ReqType.GET_NEIGHBOURS)
    .u8(0) // request version
    .u8(NEIGHBOURS_PER_PAGE)
    .u16(offset)
    .u8(2) // strongest SNR first
    .u8(NEIGHBOUR_PREFIX)
    .bytes(crypto.getRandomValues(new Uint8Array(4)))
    .finish()

/** CLI command to a server we are logged in to as admin. The radio replaces the timestamp. */
export const cmdSendCli = (prefix: Uint8Array, text: string) =>
  new LeWriter()
    .u8(Cmd.SEND_TXT_MSG)
    .u8(TxtType.CLI_DATA)
    .u8(0)
    .u32(0)
    .bytes(prefix.subarray(0, 6))
    .bytes(utf8Encode(text))
    .finish()

/** Trace along 1-byte hop hashes (flags path_sz = 0). */
export const cmdTracePath = (tag: number, hashes: Uint8Array) =>
  new LeWriter().u8(RemoteCmd.SEND_TRACE_PATH).u32(tag).u32(0).u8(0).bytes(hashes).finish()

/**
 * CMD_SEND_CONTROL_DATA with NODE_DISCOVER_REQ, sent zero-hop: [0x80][type mask][tag u32].
 * Full keys in replies (prefix_only = 0); the mask asks every node type.
 */
export const cmdDiscover = (tag: number) => new LeWriter().u8(55).u8(0x80).u8(0xff).u32(tag).finish()

export interface DiscoverReply {
  tag: number
  nodeType: number
  publicKey: Uint8Array
  /** How we heard the reply, dB. */
  snr: number
  rssi: number
  /** How the replying node heard our request, dB. */
  snrThere: number
}

/** PUSH_CONTROL_DATA carrying a NODE_DISCOVER response, or null for other control data. */
export function decodeDiscoverReply(f: Uint8Array): DiscoverReply | null {
  const r = new LeReader(f.subarray(1))
  const snr = r.i8() / 4
  const rssi = r.i8()
  r.u8() // path_len
  const kind = r.u8()
  if ((kind & 0xf0) !== 0x90 || r.remaining < 4 + 1 + 8) return null
  const snrThere = r.i8() / 4
  const tag = r.u32()
  return { tag, nodeType: kind & 0x0f, publicKey: r.rest().slice(), snr, rssi, snrThere }
}

// Pushes

export const ROLE_NAMES = ['guest', 'read-only', 'read-write', 'admin'] as const
export type ServerRole = (typeof ROLE_NAMES)[number]

export interface LoginResult {
  prefix: string
  role: ServerRole
  /** Server clock, unix seconds. */
  serverTime?: number
  fwLevel?: number
}

/** PUSH_LOGIN_SUCCESS: [0x85][is_admin][prefix6][server ts u32][permissions][fw level]. */
export function decodeLoginSuccess(f: Uint8Array): LoginResult {
  const r = new LeReader(f.subarray(1))
  const isAdmin = r.u8()
  const prefix = hex(r.bytes(6))
  if (r.remaining < 6) return { prefix, role: isAdmin === 1 ? 'admin' : 'guest' } // legacy "OK" reply
  const serverTime = r.u32()
  const perms = r.u8()
  return { prefix, role: ROLE_NAMES[perms & 3], serverTime, fwLevel: r.u8() }
}

/** Prefix of PUSH_LOGIN_FAIL / STATUS_RESPONSE / TELEMETRY_RESPONSE: [code][0][prefix6]. */
export const pushPrefix = (f: Uint8Array) => hex(f.subarray(2, 8))

export interface Field {
  label: string
  value: string
}

const dur = (s: number) => {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`
}

/** PUSH_STATUS_RESPONSE body. Repeater and room structs share the first 48 bytes. */
export function decodeStatus(f: Uint8Array, isRoom: boolean): Field[] {
  const r = new LeReader(f.subarray(8))
  const mv = r.u16()
  const queue = r.u16()
  const noise = r.i16()
  const rssi = r.i16()
  const recv = r.u32()
  const sent = r.u32()
  const airTx = r.u32()
  const up = r.u32()
  const sentFlood = r.u32()
  const sentDirect = r.u32()
  const recvFlood = r.u32()
  const recvDirect = r.u32()
  const errFlags = r.u16()
  const snr = r.i16() / 4
  const dupDirect = r.u16()
  const dupFlood = r.u16()
  const out: Field[] = [
    { label: 'Battery', value: mv ? `${(mv / 1000).toFixed(2)} V` : '—' },
    { label: 'Uptime', value: dur(up) },
    { label: 'Noise floor', value: `${noise} dBm` },
    { label: 'Last RSSI / SNR', value: `${rssi} dBm / ${snr} dB` },
    { label: 'Packets rx / tx', value: `${recv} / ${sent}` },
    { label: 'Rx flood / direct', value: `${recvFlood} / ${recvDirect}` },
    { label: 'Tx flood / direct', value: `${sentFlood} / ${sentDirect}` },
    { label: 'Duplicates flood / direct', value: `${dupFlood} / ${dupDirect}` },
    { label: 'Airtime tx', value: `${dur(airTx)}${up ? ` (${((airTx / up) * 100).toFixed(1)}%)` : ''}` },
    { label: 'Tx queue', value: String(queue) },
  ]
  if (errFlags) out.push({ label: 'Error flags', value: `0x${errFlags.toString(16)}` })
  if (isRoom && r.remaining >= 4) {
    out.push({ label: 'Posts stored / pushed', value: `${r.u16()} / ${r.u16()}` })
  } else if (!isRoom && r.remaining >= 8) {
    const airRx = r.u32()
    out.push({ label: 'Airtime rx', value: `${dur(airRx)}${up ? ` (${((airRx / up) * 100).toFixed(1)}%)` : ''}` })
    out.push({ label: 'Receive errors', value: String(r.u32()) })
  }
  return out
}

// CayenneLPP (big-endian), as emitted by MeshCore. docs/meshcore/telemetry.md section 3.

interface LppType {
  name: string
  size: number
  signed: boolean
  fmt: (v: number[]) => string
}

const num = (div: number, unit: string, digits: number) => (v: number[]) => `${(v[0] / div).toFixed(digits)} ${unit}`

const LPP: Record<number, LppType> = {
  0: { name: 'Digital in', size: 1, signed: false, fmt: (v) => String(v[0]) },
  1: { name: 'Digital out', size: 1, signed: false, fmt: (v) => String(v[0]) },
  2: { name: 'Analog in', size: 2, signed: true, fmt: num(100, '', 2) },
  3: { name: 'Analog out', size: 2, signed: true, fmt: num(100, '', 2) },
  100: { name: 'Generic', size: 4, signed: false, fmt: (v) => String(v[0]) },
  101: { name: 'Illuminance', size: 2, signed: false, fmt: num(1, 'lx', 0) },
  102: { name: 'Presence', size: 1, signed: false, fmt: (v) => String(v[0]) },
  103: { name: 'Temperature', size: 2, signed: true, fmt: num(10, '°C', 1) },
  104: { name: 'Humidity', size: 1, signed: false, fmt: num(2, '%', 1) },
  113: { name: 'Accelerometer', size: 6, signed: true, fmt: (v) => v.map((x) => (x / 1000).toFixed(3)).join(', ') + ' G' },
  115: { name: 'Pressure', size: 2, signed: false, fmt: num(10, 'hPa', 1) },
  116: { name: 'Voltage', size: 2, signed: true, fmt: num(100, 'V', 2) },
  117: { name: 'Current', size: 2, signed: true, fmt: num(1000, 'A', 3) },
  118: { name: 'Frequency', size: 4, signed: false, fmt: num(1, 'Hz', 0) },
  120: { name: 'Percentage', size: 1, signed: false, fmt: num(1, '%', 0) },
  121: { name: 'Altitude', size: 2, signed: true, fmt: num(1, 'm', 0) },
  125: { name: 'Concentration', size: 2, signed: false, fmt: num(1, 'ppm', 0) },
  128: { name: 'Power', size: 2, signed: false, fmt: num(1, 'W', 0) },
  130: { name: 'Distance', size: 4, signed: false, fmt: num(1000, 'm', 3) },
  131: { name: 'Energy', size: 4, signed: false, fmt: num(1000, 'kWh', 3) },
  132: { name: 'Direction', size: 2, signed: false, fmt: num(1, '°', 0) },
  133: { name: 'Time', size: 4, signed: false, fmt: (v) => new Date(v[0] * 1000).toISOString() },
  134: { name: 'Gyrometer', size: 6, signed: true, fmt: (v) => v.map((x) => (x / 100).toFixed(2)).join(', ') + ' °/s' },
  135: { name: 'Colour', size: 3, signed: false, fmt: (v) => `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')}` },
  136: { name: 'GPS', size: 9, signed: true, fmt: (v) => `${(v[0] / 1e4).toFixed(4)}, ${(v[1] / 1e4).toFixed(4)}, ${(v[2] / 100).toFixed(0)} m` },
  142: { name: 'Switch', size: 1, signed: false, fmt: (v) => (v[0] ? 'on' : 'off') },
}

/** Element widths for multi-value types; everything else is one value of `size` bytes. */
const PARTS: Record<number, number> = { 113: 2, 134: 2, 135: 1, 136: 3 }

export interface Reading {
  channel: number
  type: number
  name: string
  value: string
}

function readBE(b: Uint8Array, off: number, n: number, signed: boolean) {
  let v = 0
  for (let i = 0; i < n; i++) v = v * 256 + b[off + i]
  if (signed && v >= 2 ** (8 * n - 1)) v -= 2 ** (8 * n)
  return v
}

/** Stops at channel 0 or at the first unknown type (its size cannot be known). */
export function decodeLpp(b: Uint8Array): Reading[] {
  const out: Reading[] = []
  let i = 0
  while (i + 2 <= b.length) {
    const channel = b[i]
    const type = b[i + 1]
    if (channel === 0) break
    const t = LPP[type]
    if (!t || i + 2 + t.size > b.length) break
    const part = PARTS[type] ?? t.size
    const vals: number[] = []
    for (let o = 0; o < t.size; o += part) vals.push(readBE(b, i + 2 + o, part, t.signed))
    out.push({ channel, type, name: t.name, value: t.fmt(vals) })
    i += 2 + t.size
  }
  return out
}

export interface Neighbour {
  prefix: string
  heardSecsAgo: number
  snr: number
}

/** BINARY_RESPONSE body for GET_NEIGHBOURS (after the 4-byte tag). */
export function decodeNeighbours(body: Uint8Array): { total: number; list: Neighbour[] } {
  const r = new LeReader(body)
  const total = r.i16()
  const count = r.u16()
  const list: Neighbour[] = []
  for (let i = 0; i < count && r.remaining >= NEIGHBOUR_PREFIX + 5; i++) {
    list.push({ prefix: hex(r.bytes(NEIGHBOUR_PREFIX)), heardSecsAgo: r.u32(), snr: r.i8() / 4 })
  }
  return { total, list }
}

/** PUSH_BINARY_RESPONSE: [0x8C][0][tag u32][body]. */
export const decodeBinaryResponse = (f: Uint8Array) => ({
  tag: new LeReader(f.subarray(2, 6)).u32(),
  body: f.subarray(6),
})

export interface TraceData {
  tag: number
  hashes: Uint8Array
  /** SNR at which each listed hop heard the previous one, dB. */
  snrs: number[]
  /** SNR at which we heard the last hop, dB. */
  finalSnr: number
}

/** PUSH_TRACE_DATA: [0x89][0][hash bytes n][flags][tag][auth][hashes n][snr x hops][final snr]. */
export function decodeTraceData(f: Uint8Array): TraceData {
  const r = new LeReader(f)
  r.u8()
  r.u8()
  const n = r.u8()
  const flags = r.u8()
  const tag = r.u32()
  r.u32()
  const hashes = r.bytes(n)
  const hops = n >> (flags & 3)
  const snrs: number[] = []
  for (let i = 0; i < hops; i++) snrs.push(r.i8() / 4)
  return { tag, hashes, snrs, finalSnr: r.i8() / 4 }
}
