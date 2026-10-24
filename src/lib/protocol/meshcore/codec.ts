// MeshCore companion radio protocol (examples/companion_radio in meshcore-dev/MeshCore).
// Serial framing: app→radio '<' len16le payload; radio→app '>' len16le payload.
import { cString, hex, LeReader, LeWriter, utf8Encode } from '../bytes'

export const Cmd = {
  APP_START: 1,
  SEND_TXT_MSG: 2,
  SEND_CHANNEL_TXT_MSG: 3,
  GET_CONTACTS: 4,
  GET_DEVICE_TIME: 5,
  SET_DEVICE_TIME: 6,
  SEND_SELF_ADVERT: 7,
  SYNC_NEXT_MESSAGE: 10,
  RESET_PATH: 13,
  REMOVE_CONTACT: 15,
  SHARE_CONTACT: 16,
  GET_BATT_AND_STORAGE: 20,
  DEVICE_QUERY: 22,
  SEND_STATUS_REQ: 27,
  GET_CONTACT_BY_KEY: 30,
  GET_CHANNEL: 31,
  SEND_TRACE_PATH: 36,
  SEND_TELEMETRY_REQ: 39,
  SEND_PATH_DISCOVERY_REQ: 52,
} as const

export const Resp = {
  OK: 0,
  ERR: 1,
  CONTACTS_START: 2,
  CONTACT: 3,
  END_OF_CONTACTS: 4,
  SELF_INFO: 5,
  SENT: 6,
  CONTACT_MSG_RECV: 7,
  CHANNEL_MSG_RECV: 8,
  CURR_TIME: 9,
  NO_MORE_MESSAGES: 10,
  BATT_AND_STORAGE: 12,
  DEVICE_INFO: 13,
  DISABLED: 15,
  CONTACT_MSG_RECV_V3: 16,
  CHANNEL_MSG_RECV_V3: 17,
  CHANNEL_INFO: 18,
} as const

export const Push = {
  ADVERT: 0x80,
  PATH_UPDATED: 0x81,
  SEND_CONFIRMED: 0x82,
  MSG_WAITING: 0x83,
  RAW_DATA: 0x84,
  LOGIN_SUCCESS: 0x85,
  LOGIN_FAIL: 0x86,
  STATUS_RESPONSE: 0x87,
  LOG_RX_DATA: 0x88,
  TRACE_DATA: 0x89,
  NEW_ADVERT: 0x8a,
  TELEMETRY_RESPONSE: 0x8b,
  BINARY_RESPONSE: 0x8c,
  PATH_DISCOVERY_RESPONSE: 0x8d,
  CONTROL_DATA: 0x8e,
  CONTACT_DELETED: 0x8f,
  CONTACTS_FULL: 0x90,
} as const

const CODE_NAMES: Record<number, string> = Object.fromEntries([
  ...Object.entries(Resp).map(([k, v]) => [v, `RESP_${k}`]),
  ...Object.entries(Push).map(([k, v]) => [v, `PUSH_${k}`]),
])
export const codeName = (c: number) => CODE_NAMES[c] ?? `0x${c.toString(16)}`
const CMD_NAMES: Record<number, string> = Object.fromEntries(Object.entries(Cmd).map(([k, v]) => [v, `CMD_${k}`]))
export const cmdName = (c: number) => CMD_NAMES[c] ?? `CMD_0x${c.toString(16)}`

export const ERR_NAMES: Record<number, string> = {
  1: 'unsupported command',
  2: 'not found',
  3: 'table full',
  4: 'bad state',
  5: 'file I/O error',
  6: 'illegal argument',
}

/** App protocol version we speak (enables V3 message frames with SNR). */
export const APP_VER = 3
export const PUB_KEY_SIZE = 32
const MAX_PATH_SIZE = 64
export const OUT_PATH_FLOOD = 0xff

export const ContactType = { NONE: 0, CHAT: 1, REPEATER: 2, ROOM: 3, SENSOR: 4 } as const
export const TxtType = { PLAIN: 0, CLI_DATA: 1, SIGNED_PLAIN: 2 } as const

// Framing

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 3)
  out[0] = 0x3c // '<'
  out[1] = payload.length & 0xff
  out[2] = payload.length >> 8
  out.set(payload, 3)
  return out
}

export type StreamItem = { type: 'frame'; payload: Uint8Array } | { type: 'junk'; bytes: Uint8Array }

export class FrameDecoder {
  private buf: number[] = []

  push(chunk: Uint8Array): StreamItem[] {
    const out: StreamItem[] = []
    for (const b of chunk) this.buf.push(b)
    for (;;) {
      const start = this.buf.indexOf(0x3e) // '>'
      if (start < 0) {
        if (this.buf.length) out.push({ type: 'junk', bytes: Uint8Array.from(this.buf.splice(0)) })
        break
      }
      if (start > 0) out.push({ type: 'junk', bytes: Uint8Array.from(this.buf.splice(0, start)) })
      if (this.buf.length < 3) break
      const len = this.buf[1] | (this.buf[2] << 8)
      if (len === 0 || len > 300) {
        out.push({ type: 'junk', bytes: Uint8Array.from(this.buf.splice(0, 1)) })
        continue
      }
      if (this.buf.length < 3 + len) break
      const f = this.buf.splice(0, 3 + len)
      out.push({ type: 'frame', payload: Uint8Array.from(f.slice(3)) })
    }
    return out
  }
}

// Paths: path_len packs hash size (top 2 bits, +1) and hop count (low 6 bits).

export function decodePath(pathLen: number, bytes: Uint8Array): string[] | undefined {
  if (pathLen === OUT_PATH_FLOOD) return undefined
  const size = (pathLen >> 6) + 1
  const count = pathLen & 63
  const hops: string[] = []
  for (let i = 0; i < count; i++) hops.push(hex(bytes.subarray(i * size, i * size + size)))
  return hops
}

export const pathHops = (pathLen: number) => (pathLen === OUT_PATH_FLOOD ? undefined : pathLen & 63)

// Responses

export interface DeviceInfo {
  verCode: number
  maxContacts?: number
  maxChannels?: number
  buildDate?: string
  manufacturer?: string
  firmware?: string
  repeat?: boolean
  pathHashMode?: number
}

export function decodeDeviceInfo(f: Uint8Array): DeviceInfo {
  const r = new LeReader(f)
  r.u8()
  const d: DeviceInfo = { verCode: r.u8() }
  if (d.verCode >= 3 && r.remaining >= 2) {
    d.maxContacts = r.u8() * 2
    d.maxChannels = r.u8()
  }
  if (r.remaining >= 4 + 12 + 40 + 20) {
    r.u32() // BLE pin
    d.buildDate = r.cstr(12)
    d.manufacturer = r.cstr(40)
    d.firmware = r.cstr(20)
  }
  if (r.remaining >= 1) d.repeat = r.u8() === 1
  if (r.remaining >= 1) d.pathHashMode = r.u8()
  return d
}

export interface SelfInfo {
  advType: number
  txPower: number
  maxTxPower: number
  publicKey: Uint8Array
  lat: number
  lon: number
  multiAcks: number
  advertLocPolicy: number
  telemetryModes: number
  manualAddContacts: number
  freqMHz: number
  bwKHz: number
  sf: number
  cr: number
  name: string
}

export function decodeSelfInfo(f: Uint8Array): SelfInfo {
  const r = new LeReader(f)
  r.u8()
  const s = {
    advType: r.u8(),
    txPower: r.i8(), // can be negative
    maxTxPower: r.u8(),
    publicKey: r.bytes(PUB_KEY_SIZE),
    lat: r.i32() / 1e6,
    lon: r.i32() / 1e6,
    multiAcks: r.u8(),
    advertLocPolicy: r.u8(),
    telemetryModes: r.u8(),
    manualAddContacts: r.u8(),
    freqMHz: r.u32() / 1000,
    bwKHz: r.u32() / 1000,
    sf: r.u8(),
    cr: r.u8(),
    name: '',
  }
  s.name = new TextDecoder().decode(r.rest())
  return s
}

export interface Contact {
  publicKey: Uint8Array
  type: number
  flags: number
  outPathLen: number
  outPath: Uint8Array
  name: string
  lastAdvert: number
  lat: number
  lon: number
  lastMod: number
}

/** RESP_CONTACT and PUSH_NEW_ADVERT share this layout. */
export function decodeContact(f: Uint8Array): Contact {
  const r = new LeReader(f)
  r.u8()
  const c: Contact = {
    publicKey: r.bytes(PUB_KEY_SIZE),
    type: r.u8(),
    flags: r.u8(),
    outPathLen: r.u8(),
    outPath: r.bytes(MAX_PATH_SIZE),
    name: r.cstr(32),
    lastAdvert: r.u32(),
    lat: 0,
    lon: 0,
    lastMod: 0,
  }
  if (r.remaining >= 8) {
    c.lat = r.i32() / 1e6
    c.lon = r.i32() / 1e6
  }
  if (r.remaining >= 4) c.lastMod = r.u32()
  return c
}

export interface ChannelInfo {
  index: number
  name: string
  secret: Uint8Array
}

export function decodeChannelInfo(f: Uint8Array): ChannelInfo {
  const r = new LeReader(f)
  r.u8()
  return { index: r.u8(), name: r.cstr(32), secret: r.bytes(16) }
}

export interface RecvMessage {
  channel?: number
  /** DMs: first 6 bytes of sender public key. */
  senderPrefix?: Uint8Array
  snr?: number
  pathLen: number
  txtType: number
  senderTs: number
  /** Room posts: first 4 bytes (hex) of the author's public key. */
  author?: string
  text: string
}

export function decodeContactMsg(f: Uint8Array): RecvMessage {
  const r = new LeReader(f)
  const code = r.u8()
  let snr: number | undefined
  if (code === Resp.CONTACT_MSG_RECV_V3) {
    snr = r.i8() / 4
    r.u16()
  }
  const senderPrefix = r.bytes(6)
  const pathLen = r.u8()
  const txtType = r.u8()
  const senderTs = r.u32()
  // Room server posts carry the author's key prefix.
  const author = txtType === TxtType.SIGNED_PLAIN ? hex(r.bytes(4)) : undefined
  return { senderPrefix, snr, pathLen, txtType, senderTs, author, text: new TextDecoder().decode(r.rest()) }
}

export function decodeChannelMsg(f: Uint8Array): RecvMessage {
  const r = new LeReader(f)
  const code = r.u8()
  let snr: number | undefined
  if (code === Resp.CHANNEL_MSG_RECV_V3) {
    snr = r.i8() / 4
    r.u16()
  }
  const channel = r.u8()
  const pathLen = r.u8()
  const txtType = r.u8()
  const senderTs = r.u32()
  return { channel, snr, pathLen, txtType, senderTs, text: new TextDecoder().decode(r.rest()) }
}

export interface Sent {
  flood: boolean
  /** Expected ACK code (DMs) or request tag. */
  tag: number
  timeoutMs: number
}

export function decodeSent(f: Uint8Array): Sent {
  const r = new LeReader(f)
  r.u8()
  return { flood: r.u8() === 1, tag: r.u32(), timeoutMs: r.u32() }
}

export interface PathDiscovery {
  prefix: Uint8Array
  out?: string[]
  in?: string[]
}

export function decodePathDiscovery(f: Uint8Array): PathDiscovery {
  const r = new LeReader(f)
  r.u8()
  r.u8()
  const prefix = r.bytes(6)
  const outLen = r.u8()
  const outBytes = outLen === OUT_PATH_FLOOD ? new Uint8Array() : r.bytes(((outLen >> 6) + 1) * (outLen & 63))
  const inLen = r.u8()
  const inBytes = inLen === OUT_PATH_FLOOD ? new Uint8Array() : r.bytes(((inLen >> 6) + 1) * (inLen & 63))
  return { prefix, out: decodePath(outLen, outBytes), in: decodePath(inLen, inBytes) }
}

/** LOG_RX_DATA: SNR, RSSI and the raw over-the-air packet. */
export function decodeRxLog(f: Uint8Array) {
  const r = new LeReader(f)
  r.u8()
  const snr = r.i8() / 4
  const rssi = r.i8()
  const raw = r.rest()
  const header = raw[0] ?? 0
  return {
    snr,
    rssi,
    raw,
    routeType: header & 0x03,
    payloadType: (header >> 2) & 0x0f,
  }
}

/**
 * Ciphertext of a GRP_TXT the radio sends for us: AES-128-ECB over
 * [ts u32][txt type 0]["<name>: <text>"], zero-padded. Used to recognise
 * repeats of our own channel messages in LOG_RX_DATA.
 */
export async function groupTextCiphertext(secret: Uint8Array, ts: number, name: string, text: string) {
  const body = utf8Encode(`${name}: ${text}`)
  const plain = new Uint8Array(Math.ceil((5 + body.length) / 16) * 16)
  new DataView(plain.buffer).setUint32(0, ts, true)
  plain.set(body, 5)
  const key = await crypto.subtle.importKey('raw', secret.slice(0, 16), 'AES-CBC', false, ['encrypt'])
  const out = new Uint8Array(plain.length)
  // ECB via single-block CBC with a zero IV; WebCrypto has no ECB mode.
  for (let i = 0; i < plain.length; i += 16) {
    const block = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, plain.slice(i, i + 16))
    out.set(new Uint8Array(block, 0, 16), i)
  }
  return out
}

export const PayloadType = { GRP_TXT: 5 } as const

export const PAYLOAD_TYPES: Record<number, string> = {
  0: 'REQ', 1: 'RESPONSE', 2: 'TXT_MSG', 3: 'ACK', 4: 'ADVERT', 5: 'GRP_TXT', 6: 'GRP_DATA',
  7: 'ANON_REQ', 8: 'PATH', 9: 'TRACE', 10: 'MULTIPART', 11: 'CONTROL', 15: 'RAW_CUSTOM',
}

// Commands

export const cmdDeviceQuery = () => Uint8Array.of(Cmd.DEVICE_QUERY, APP_VER)
export const cmdAppStart = (appName: string) =>
  new LeWriter().u8(Cmd.APP_START).bytes(new Uint8Array(7)).bytes(utf8Encode(appName)).finish()
export const cmdGetContacts = () => Uint8Array.of(Cmd.GET_CONTACTS)
export const cmdGetChannel = (i: number) => Uint8Array.of(Cmd.GET_CHANNEL, i)
export const cmdGetTime = () => Uint8Array.of(Cmd.GET_DEVICE_TIME)
export const cmdSetTime = (secs: number) => new LeWriter().u8(Cmd.SET_DEVICE_TIME).u32(secs).finish()
export const cmdGetBattery = () => Uint8Array.of(Cmd.GET_BATT_AND_STORAGE)
export const cmdSyncNext = () => Uint8Array.of(Cmd.SYNC_NEXT_MESSAGE)
export const cmdAdvert = (flood: boolean) => Uint8Array.of(Cmd.SEND_SELF_ADVERT, flood ? 1 : 0)
export const cmdGetContactByKey = (pk: Uint8Array) => new LeWriter().u8(Cmd.GET_CONTACT_BY_KEY).bytes(pk).finish()
export const cmdResetPath = (pk: Uint8Array) => new LeWriter().u8(Cmd.RESET_PATH).bytes(pk).finish()
export const cmdRemoveContact = (pk: Uint8Array) => new LeWriter().u8(Cmd.REMOVE_CONTACT).bytes(pk).finish()
export const cmdShareContact = (pk: Uint8Array) => new LeWriter().u8(Cmd.SHARE_CONTACT).bytes(pk).finish()
export const cmdPathDiscovery = (pk: Uint8Array) =>
  new LeWriter().u8(Cmd.SEND_PATH_DISCOVERY_REQ).u8(0).bytes(pk).finish()

export const cmdSendText = (prefix: Uint8Array, text: string, ts: number, attempt = 0) =>
  new LeWriter().u8(Cmd.SEND_TXT_MSG).u8(TxtType.PLAIN).u8(attempt).u32(ts).bytes(prefix.subarray(0, 6)).bytes(utf8Encode(text)).finish()

export const cmdSendChannelText = (channel: number, text: string, ts: number) =>
  new LeWriter().u8(Cmd.SEND_CHANNEL_TXT_MSG).u8(TxtType.PLAIN).u8(channel).u32(ts).bytes(utf8Encode(text)).finish()

export { cString }
