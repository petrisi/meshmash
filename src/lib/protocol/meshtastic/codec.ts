// Decoders/encoders for the Meshtastic messages the client uses. Field numbers follow
// meshtastic/protobufs (mesh.proto, channel.proto, config.proto, telemetry.proto, admin.proto).
import {
  asBool,
  asBytes,
  asFixed32,
  asFloat,
  asInt32,
  asSfixed32,
  asString,
  asUint,
  fields,
  PbWriter,
  repeatedFixed32,
  repeatedInt32,
} from '../protobuf'

export const BROADCAST = 0xffffffff

export const Port = {
  TEXT: 1,
  POSITION: 3,
  NODEINFO: 4,
  ROUTING: 5,
  ADMIN: 6,
  WAYPOINT: 8,
  TELEMETRY: 67,
  TRACEROUTE: 70,
  NEIGHBORINFO: 71,
} as const

export interface User {
  id?: string
  longName?: string
  shortName?: string
  hwModel?: number
  role?: number
  publicKey?: Uint8Array
  isUnmessagable?: boolean
}

export interface Position {
  lat?: number
  lon?: number
  alt?: number
  time?: number
}

export interface DeviceMetrics {
  batteryLevel?: number
  voltage?: number
  channelUtil?: number
  airUtilTx?: number
  uptime?: number
}

export interface NodeInfo {
  num: number
  user?: User
  position?: Position
  snr?: number
  lastHeard?: number
  deviceMetrics?: DeviceMetrics
  channel?: number
  viaMqtt?: boolean
  hopsAway?: number
  isFavorite?: boolean
  isIgnored?: boolean
}

export interface Data {
  portnum: number
  payload: Uint8Array
  wantResponse?: boolean
  dest?: number
  source?: number
  requestId?: number
  replyId?: number
  emoji?: number
}

export interface MeshPacket {
  from: number
  to: number
  channel: number
  id: number
  rxTime?: number
  rxSnr?: number
  hopLimit?: number
  wantAck?: boolean
  rxRssi?: number
  viaMqtt?: boolean
  hopStart?: number
  pkiEncrypted?: boolean
  relayNode?: number
  decoded?: Data
  encrypted?: Uint8Array
}

export interface ChannelInfo {
  index: number
  role: number
  name: string
  psk: Uint8Array
  muted: boolean
}

export interface LoRaConfig {
  usePreset?: boolean
  modemPreset?: number
  bandwidth?: number
  spreadFactor?: number
  codingRate?: number
  region?: number
  hopLimit?: number
  txPower?: number
  overrideFrequency?: number
}

export interface Metadata {
  firmwareVersion?: string
  hwModel?: number
  role?: number
  hasWifi?: boolean
  hasBluetooth?: boolean
  hasPKC?: boolean
}

export interface MyInfo {
  myNodeNum: number
  rebootCount?: number
  minAppVersion?: number
  pioEnv?: string
  nodedbCount?: number
}

export interface RouteDiscovery {
  route: number[]
  snrTowards: number[]
  routeBack: number[]
  snrBack: number[]
}

export interface Routing {
  errorReason?: number
  routeRequest?: RouteDiscovery
  routeReply?: RouteDiscovery
}

export type FromRadio = { id?: number } & (
  | { kind: 'packet'; packet: MeshPacket }
  | { kind: 'my_info'; myInfo: MyInfo }
  | { kind: 'node_info'; node: NodeInfo }
  | { kind: 'config'; section: string; lora?: LoRaConfig; deviceRole?: number }
  | { kind: 'log_record'; message: string; level?: number; source?: string }
  | { kind: 'config_complete_id'; nonce: number }
  | { kind: 'rebooted' }
  | { kind: 'module_config' }
  | { kind: 'channel'; channel: ChannelInfo }
  | { kind: 'queue_status'; res: number; free: number; maxlen: number; meshPacketId: number }
  | { kind: 'metadata'; metadata: Metadata }
  | { kind: 'client_notification'; message: string; level?: number }
  | { kind: 'other'; field: number }
)

export function decodeUser(b: Uint8Array): User {
  const u: User = {}
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: u.id = asString(f.value); break
      case 2: u.longName = asString(f.value); break
      case 3: u.shortName = asString(f.value); break
      case 5: u.hwModel = asUint(f.value); break
      case 7: u.role = asUint(f.value); break
      case 8: u.publicKey = asBytes(f.value); break
      case 9: u.isUnmessagable = asBool(f.value); break
    }
  }
  return u
}

export function decodePosition(b: Uint8Array): Position {
  const p: Position = {}
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: p.lat = asSfixed32(f.value) * 1e-7; break
      case 2: p.lon = asSfixed32(f.value) * 1e-7; break
      case 3: p.alt = asInt32(f.value); break
      case 4: p.time = asFixed32(f.value); break
    }
  }
  return p
}

export function decodeDeviceMetrics(b: Uint8Array): DeviceMetrics {
  const m: DeviceMetrics = {}
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: m.batteryLevel = asUint(f.value); break
      case 2: {
        // Firmware sends a tiny negative value when no battery is sensed.
        const v = asFloat(f.value)
        m.voltage = v > 0 ? v : undefined
        break
      }
      case 3: m.channelUtil = asFloat(f.value); break
      case 4: m.airUtilTx = asFloat(f.value); break
      case 5: m.uptime = asUint(f.value); break
    }
  }
  return m
}

/** Telemetry: only the device_metrics variant is used. */
export function decodeTelemetry(b: Uint8Array): { time?: number; deviceMetrics?: DeviceMetrics } {
  const t: { time?: number; deviceMetrics?: DeviceMetrics } = {}
  for (const f of fields(b)) {
    if (f.no === 1) t.time = asFixed32(f.value)
    else if (f.no === 2) t.deviceMetrics = decodeDeviceMetrics(asBytes(f.value))
  }
  return t
}

export function decodeNodeInfo(b: Uint8Array): NodeInfo {
  const n: NodeInfo = { num: 0 }
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: n.num = asUint(f.value); break
      case 2: n.user = decodeUser(asBytes(f.value)); break
      case 3: n.position = decodePosition(asBytes(f.value)); break
      case 4: n.snr = asFloat(f.value); break
      case 5: n.lastHeard = asFixed32(f.value); break
      case 6: n.deviceMetrics = decodeDeviceMetrics(asBytes(f.value)); break
      case 7: n.channel = asUint(f.value); break
      case 8: n.viaMqtt = asBool(f.value); break
      case 9: n.hopsAway = asUint(f.value); break
      case 10: n.isFavorite = asBool(f.value); break
      case 11: n.isIgnored = asBool(f.value); break
    }
  }
  return n
}

export function decodeData(b: Uint8Array): Data {
  const d: Data = { portnum: 0, payload: new Uint8Array() }
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: d.portnum = asUint(f.value); break
      case 2: d.payload = asBytes(f.value); break
      case 3: d.wantResponse = asBool(f.value); break
      case 4: d.dest = asFixed32(f.value); break
      case 5: d.source = asFixed32(f.value); break
      case 6: d.requestId = asFixed32(f.value); break
      case 7: d.replyId = asFixed32(f.value); break
      case 8: d.emoji = asFixed32(f.value); break
    }
  }
  return d
}

export function decodeMeshPacket(b: Uint8Array): MeshPacket {
  const p: MeshPacket = { from: 0, to: 0, channel: 0, id: 0 }
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: p.from = asFixed32(f.value); break
      case 2: p.to = asFixed32(f.value); break
      case 3: p.channel = asUint(f.value); break
      case 4: p.decoded = decodeData(asBytes(f.value)); break
      case 5: p.encrypted = asBytes(f.value); break
      case 6: p.id = asFixed32(f.value); break
      case 7: p.rxTime = asFixed32(f.value); break
      case 8: p.rxSnr = asFloat(f.value); break
      case 9: p.hopLimit = asUint(f.value); break
      case 10: p.wantAck = asBool(f.value); break
      case 12: p.rxRssi = asInt32(f.value); break
      case 14: p.viaMqtt = asBool(f.value); break
      case 15: p.hopStart = asUint(f.value); break
      case 17: p.pkiEncrypted = asBool(f.value); break
      case 19: p.relayNode = asUint(f.value); break
    }
  }
  return p
}

function decodeChannel(b: Uint8Array): ChannelInfo {
  const c: ChannelInfo = { index: 0, role: 0, name: '', psk: new Uint8Array(), muted: false }
  for (const f of fields(b)) {
    if (f.no === 1) c.index = asInt32(f.value)
    else if (f.no === 3) c.role = asUint(f.value)
    else if (f.no === 2) {
      for (const s of fields(asBytes(f.value))) {
        if (s.no === 2) c.psk = asBytes(s.value)
        else if (s.no === 3) c.name = asString(s.value)
        else if (s.no === 7) for (const m of fields(asBytes(s.value))) if (m.no === 2) c.muted = asBool(m.value)
      }
    }
  }
  return c
}

function decodeLoRa(b: Uint8Array): LoRaConfig {
  const l: LoRaConfig = {}
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: l.usePreset = asBool(f.value); break
      case 2: l.modemPreset = asUint(f.value); break
      case 3: l.bandwidth = asUint(f.value); break
      case 4: l.spreadFactor = asUint(f.value); break
      case 5: l.codingRate = asUint(f.value); break
      case 7: l.region = asUint(f.value); break
      case 8: l.hopLimit = asUint(f.value); break
      case 10: l.txPower = asInt32(f.value); break
      case 14: l.overrideFrequency = asFloat(f.value); break
    }
  }
  return l
}

const CONFIG_SECTIONS: Record<number, string> = {
  1: 'device', 2: 'position', 3: 'power', 4: 'network', 5: 'display',
  6: 'lora', 7: 'bluetooth', 8: 'security', 9: 'sessionkey', 10: 'device_ui',
}

function decodeMetadata(b: Uint8Array): Metadata {
  const m: Metadata = {}
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: m.firmwareVersion = asString(f.value); break
      case 4: m.hasWifi = asBool(f.value); break
      case 5: m.hasBluetooth = asBool(f.value); break
      case 7: m.role = asUint(f.value); break
      case 9: m.hwModel = asUint(f.value); break
      case 11: m.hasPKC = asBool(f.value); break
    }
  }
  return m
}

function decodeMyInfo(b: Uint8Array): MyInfo {
  const m: MyInfo = { myNodeNum: 0 }
  for (const f of fields(b)) {
    switch (f.no) {
      case 1: m.myNodeNum = asUint(f.value); break
      case 8: m.rebootCount = asUint(f.value); break
      case 11: m.minAppVersion = asUint(f.value); break
      case 13: m.pioEnv = asString(f.value); break
      case 15: m.nodedbCount = asUint(f.value); break
    }
  }
  return m
}

export function decodeRouteDiscovery(b: Uint8Array): RouteDiscovery {
  const r: RouteDiscovery = { route: [], snrTowards: [], routeBack: [], snrBack: [] }
  for (const f of fields(b)) {
    if (f.no === 1) r.route.push(...repeatedFixed32(f.value, f.type))
    else if (f.no === 2) r.snrTowards.push(...repeatedInt32(f.value, f.type))
    else if (f.no === 3) r.routeBack.push(...repeatedFixed32(f.value, f.type))
    else if (f.no === 4) r.snrBack.push(...repeatedInt32(f.value, f.type))
  }
  return r
}

export function decodeRouting(b: Uint8Array): Routing {
  const r: Routing = {}
  for (const f of fields(b)) {
    if (f.no === 1) r.routeRequest = decodeRouteDiscovery(asBytes(f.value))
    else if (f.no === 2) r.routeReply = decodeRouteDiscovery(asBytes(f.value))
    else if (f.no === 3) r.errorReason = asUint(f.value)
  }
  return r
}

export function decodeFromRadio(b: Uint8Array): FromRadio {
  let id: number | undefined
  for (const f of fields(b)) {
    const v = f.value
    switch (f.no) {
      case 1: id = asUint(v); continue
      case 2: return { id, kind: 'packet', packet: decodeMeshPacket(asBytes(v)) }
      case 3: return { id, kind: 'my_info', myInfo: decodeMyInfo(asBytes(v)) }
      case 4: return { id, kind: 'node_info', node: decodeNodeInfo(asBytes(v)) }
      case 5: {
        for (const s of fields(asBytes(v))) {
          const section = CONFIG_SECTIONS[s.no] ?? `#${s.no}`
          if (s.no === 6) return { id, kind: 'config', section, lora: decodeLoRa(asBytes(s.value)) }
          if (s.no === 1) {
            let role = 0
            for (const d of fields(asBytes(s.value))) if (d.no === 1) role = asUint(d.value)
            return { id, kind: 'config', section, deviceRole: role }
          }
          return { id, kind: 'config', section }
        }
        return { id, kind: 'config', section: '?' }
      }
      case 6: {
        const r = { id, kind: 'log_record' as const, message: '', level: 0, source: '' }
        for (const s of fields(asBytes(v))) {
          if (s.no === 1) r.message = asString(s.value)
          else if (s.no === 3) r.source = asString(s.value)
          else if (s.no === 4) r.level = asUint(s.value)
        }
        return r
      }
      case 7: return { id, kind: 'config_complete_id', nonce: asUint(v) }
      case 8: return { id, kind: 'rebooted' }
      case 9: return { id, kind: 'module_config' }
      case 10: return { id, kind: 'channel', channel: decodeChannel(asBytes(v)) }
      case 11: {
        const q = { id, kind: 'queue_status' as const, res: 0, free: 0, maxlen: 0, meshPacketId: 0 }
        for (const s of fields(asBytes(v))) {
          if (s.no === 1) q.res = asInt32(s.value)
          else if (s.no === 2) q.free = asUint(s.value)
          else if (s.no === 3) q.maxlen = asUint(s.value)
          else if (s.no === 4) q.meshPacketId = asUint(s.value)
        }
        return q
      }
      case 13: return { id, kind: 'metadata', metadata: decodeMetadata(asBytes(v)) }
      case 16: {
        const n = { id, kind: 'client_notification' as const, message: '', level: 0 }
        for (const s of fields(asBytes(v))) {
          if (s.no === 4) n.message = asString(s.value)
          else if (s.no === 3) n.level = asUint(s.value)
        }
        return n
      }
      default: return { id, kind: 'other', field: f.no }
    }
  }
  return { id, kind: 'other', field: 0 }
}

// Encoders (ToRadio and payloads).

export function toRadioWantConfig(nonce: number): Uint8Array {
  return new PbWriter().uint(3, nonce).finish()
}

export function toRadioHeartbeat(nonce = 0): Uint8Array {
  return new PbWriter().message(7, new PbWriter().uint(1, nonce)).finish()
}

export function toRadioDisconnect(): Uint8Array {
  return new PbWriter().bool(4, true).finish()
}

export interface OutPacket {
  to: number
  channel: number
  id: number
  wantAck: boolean
  hopLimit?: number
  portnum: number
  payload: Uint8Array
  wantResponse?: boolean
}

export function toRadioPacket(p: OutPacket): Uint8Array {
  const data = new PbWriter().uint(1, p.portnum).bytes(2, p.payload)
  if (p.wantResponse) data.bool(3, true)
  const pkt = new PbWriter().fixed32(2, p.to)
  if (p.channel) pkt.uint(3, p.channel)
  pkt.message(4, data).fixed32(6, p.id)
  if (p.hopLimit) pkt.uint(9, p.hopLimit)
  if (p.wantAck) pkt.bool(10, true)
  return new PbWriter().message(1, pkt).finish()
}

export function encodeUser(u: User): Uint8Array {
  const w = new PbWriter()
  if (u.id) w.string(1, u.id)
  if (u.longName) w.string(2, u.longName)
  if (u.shortName) w.string(3, u.shortName)
  if (u.hwModel) w.uint(5, u.hwModel)
  if (u.role) w.uint(7, u.role)
  if (u.publicKey?.length) w.bytes(8, u.publicKey)
  return w.finish()
}

export function encodePosition(p: Position): Uint8Array {
  const w = new PbWriter()
  const sfixed = (no: number, v: number) => w.fixed32(no, Math.round(v * 1e7) >>> 0)
  if (p.lat !== undefined) sfixed(1, p.lat)
  if (p.lon !== undefined) sfixed(2, p.lon)
  if (p.alt !== undefined) w.int32(3, Math.round(p.alt))
  w.fixed32(4, Math.floor(Date.now() / 1000))
  return w.finish()
}

/** Telemetry request: an empty device_metrics variant. */
export function encodeTelemetryRequest(): Uint8Array {
  return new PbWriter().bytes(2, new Uint8Array()).finish()
}

export function encodeRouteDiscovery(): Uint8Array {
  return new Uint8Array()
}

/** AdminMessage with a single uint32 variant (set/remove ignored/favorite, remove node). */
export function encodeAdminUint(field: number, value: number): Uint8Array {
  return new PbWriter().uint(field, value).finish()
}

export const Admin = {
  REMOVE_BY_NODENUM: 38,
  SET_FAVORITE: 39,
  REMOVE_FAVORITE: 40,
  SET_IGNORED: 47,
  REMOVE_IGNORED: 48,
} as const
