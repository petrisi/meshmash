import { describe, expect, it } from 'vitest'
import {
  BROADCAST,
  decodeDeviceMetrics,
  decodeFromRadio,
  decodeMeshPacket,
  decodeNeighborInfo,
  decodePosition,
  decodeRouteDiscovery,
  decodeRouting,
  decodeTelemetry,
  decodeUser,
  encodeAdminUint,
  encodePosition,
  encodeTelemetryRequest,
  encodeUser,
  Port,
  toRadioDisconnect,
  toRadioHeartbeat,
  toRadioPacket,
  toRadioWantConfig,
  type FromRadio,
} from '../src/lib/protocol/meshtastic/codec'
import { asBytes, asUint, fields, PbWriter } from '../src/lib/protocol/protobuf'
import { f32 } from './helpers'

const fromRadio = (no: number, inner: PbWriter, id = 7) => new PbWriter().uint(1, id).message(no, inner).finish()
const as = <K extends FromRadio['kind']>(m: FromRadio, kind: K) => {
  expect(m.kind).toBe(kind)
  return m as Extract<FromRadio, { kind: K }>
}

const PK = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const user = () =>
  new PbWriter()
    .string(1, '!0a0b0c0d')
    .string(2, 'Test Node')
    .string(3, 'TN')
    .bytes(4, Uint8Array.of(1, 2, 3, 4, 5, 6)) // deprecated macaddr
    .uint(5, 43)
    .uint(7, 2)
    .bytes(8, PK)

describe('decodeFromRadio', () => {
  it('decodes my_info', () => {
    const b = fromRadio(3, new PbWriter().uint(1, 0xdeadbeef).uint(8, 5).uint(11, 30200).string(13, 'tbeam').uint(15, 42))
    const m = as(decodeFromRadio(b), 'my_info')
    expect(m.id).toBe(7)
    expect(m.myInfo).toEqual({ myNodeNum: 0xdeadbeef, rebootCount: 5, minAppVersion: 30200, pioEnv: 'tbeam', nodedbCount: 42 })
  })

  it('decodes node_info with user, position, metrics', () => {
    const pos = new PbWriter().fixed32(1, Math.round(60.1699 * 1e7)).fixed32(2, Math.round(-24.9384 * 1e7) >>> 0).int32(3, -12).fixed32(4, 1_700_000_000)
    const metrics = new PbWriter().uint(1, 87).fixed32(2, f32(3.95)).fixed32(3, f32(12.5)).fixed32(4, f32(1.25)).uint(5, 3600)
    const ni = new PbWriter()
      .uint(1, 0x0a0b0c0d)
      .message(2, user())
      .message(3, pos)
      .fixed32(4, f32(-6.25))
      .fixed32(5, 1_700_000_100)
      .message(6, metrics)
      .uint(7, 1)
      .bool(8, true)
      .uint(9, 3)
      .bool(10, true)
    const { node } = as(decodeFromRadio(fromRadio(4, ni)), 'node_info')
    expect(node.num).toBe(0x0a0b0c0d)
    expect(node.user).toMatchObject({ id: '!0a0b0c0d', longName: 'Test Node', shortName: 'TN', hwModel: 43, role: 2, publicKey: PK })
    expect(node.position!.lat).toBeCloseTo(60.1699, 6)
    expect(node.position!.lon).toBeCloseTo(-24.9384, 6)
    expect(node.position!.alt).toBe(-12)
    expect(node.position!.time).toBe(1_700_000_000)
    expect(node.snr).toBe(-6.25)
    expect(node.lastHeard).toBe(1_700_000_100)
    expect(node.deviceMetrics!.batteryLevel).toBe(87)
    expect(node.deviceMetrics!.voltage).toBeCloseTo(3.95, 5)
    expect(node.deviceMetrics!.uptime).toBe(3600)
    expect(node).toMatchObject({ channel: 1, viaMqtt: true, hopsAway: 3, isFavorite: true })
    expect(node.isIgnored).toBeUndefined()
  })

  it('decodes a channel with psk, name and mute flag', () => {
    const settings = new PbWriter().bytes(2, Uint8Array.of(1)).string(3, 'LongFast').message(7, new PbWriter().uint(1, 0).bool(2, true))
    const { channel } = as(decodeFromRadio(fromRadio(10, new PbWriter().uint(1, 2).message(2, settings).uint(3, 2))), 'channel')
    expect(channel).toEqual({ index: 2, role: 2, name: 'LongFast', psk: Uint8Array.of(1), muted: true })
  })

  it('defaults an omitted channel index and role to 0', () => {
    const { channel } = as(decodeFromRadio(fromRadio(10, new PbWriter())), 'channel')
    expect(channel).toEqual({ index: 0, role: 0, name: '', psk: new Uint8Array(), muted: false })
  })

  it('decodes lora config with use_preset present', () => {
    const lora = new PbWriter().bool(1, true).uint(2, 3).uint(7, 3).uint(8, 3).int32(10, -2).fixed32(14, f32(869.525))
    const m = as(decodeFromRadio(fromRadio(5, new PbWriter().message(6, lora))), 'config')
    expect(m.section).toBe('lora')
    expect(m.lora).toMatchObject({ usePreset: true, modemPreset: 3, region: 3, hopLimit: 3, txPower: -2 })
    expect(m.lora!.overrideFrequency).toBeCloseTo(869.525, 3)
  })

  it('decodes lora config with use_preset absent (custom modem)', () => {
    const lora = new PbWriter().uint(3, 250).uint(4, 11).uint(5, 5).uint(7, 3)
    const m = as(decodeFromRadio(fromRadio(5, new PbWriter().message(6, lora))), 'config')
    expect(m.lora!.usePreset).toBeUndefined()
    expect(m.lora).toMatchObject({ bandwidth: 250, spreadFactor: 11, codingRate: 5, region: 3 })
  })

  it('decodes device config role and other sections by name', () => {
    const dev = as(decodeFromRadio(fromRadio(5, new PbWriter().message(1, new PbWriter().uint(1, 4)))), 'config')
    expect(dev).toMatchObject({ section: 'device', deviceRole: 4 })
    expect(as(decodeFromRadio(fromRadio(5, new PbWriter().message(8, new PbWriter()))), 'config').section).toBe('security')
    expect(as(decodeFromRadio(fromRadio(5, new PbWriter().message(42, new PbWriter()))), 'config').section).toBe('#42')
  })

  it('decodes queue_status including a negative result', () => {
    const q = as(decodeFromRadio(fromRadio(11, new PbWriter().int32(1, -1).uint(2, 14).uint(3, 16).uint(4, 0x12345678))), 'queue_status')
    expect(q).toMatchObject({ res: -1, free: 14, maxlen: 16, meshPacketId: 0x12345678 })
  })

  it('decodes config_complete_id, rebooted, log_record, metadata', () => {
    expect(decodeFromRadio(new PbWriter().uint(7, 99).finish())).toEqual({ id: undefined, kind: 'config_complete_id', nonce: 99 })
    expect(decodeFromRadio(new PbWriter().bool(8, true).finish()).kind).toBe('rebooted')
    const log = as(decodeFromRadio(fromRadio(6, new PbWriter().string(1, 'hello').string(3, 'Router').uint(4, 20))), 'log_record')
    expect(log).toMatchObject({ message: 'hello', source: 'Router', level: 20 })
    const md = new PbWriter().string(1, '2.6.11.abc').bool(4, true).bool(5, true).uint(7, 1).uint(9, 43).bool(11, true)
    expect(as(decodeFromRadio(fromRadio(13, md)), 'metadata').metadata).toEqual({
      firmwareVersion: '2.6.11.abc',
      hasWifi: true,
      hasBluetooth: true,
      role: 1,
      hwModel: 43,
      hasPKC: true,
    })
  })

  it('returns other for unknown or empty messages', () => {
    expect(decodeFromRadio(new PbWriter().uint(99, 1).finish())).toEqual({ id: undefined, kind: 'other', field: 99 })
    expect(decodeFromRadio(new Uint8Array())).toEqual({ id: undefined, kind: 'other', field: 0 })
  })
})

describe('sub-message decoders', () => {
  it('decodeUser keeps a copy of the raw bytes, including unmodelled fields', () => {
    const b = user().finish()
    const u = decodeUser(b)
    expect(u.raw).toEqual(b)
    b[0] ^= 0xff
    expect(u.raw![0]).not.toBe(b[0])
    // encodeUser drops macaddr, so raw is the only lossless copy.
    expect(encodeUser(u).length).toBeLessThan(u.raw!.length)
    expect(decodeUser(encodeUser(u))).toMatchObject({ id: u.id, longName: u.longName, shortName: u.shortName, hwModel: 43, role: 2 })
  })

  it('decodeDeviceMetrics maps voltage <= 0 to undefined', () => {
    for (const v of [0, -0.001, -1]) expect(decodeDeviceMetrics(new PbWriter().fixed32(2, f32(v)).finish()).voltage).toBeUndefined()
    expect(decodeDeviceMetrics(new PbWriter().fixed32(2, f32(4.2)).finish()).voltage).toBeCloseTo(4.2, 5)
  })

  it('decodePosition maps altitude 0 to undefined', () => {
    expect(decodePosition(new PbWriter().uint(3, 0).finish()).alt).toBeUndefined()
    expect(decodePosition(new PbWriter().int32(3, 120).finish()).alt).toBe(120)
  })

  it('decodeTelemetry reads time and device_metrics', () => {
    const t = decodeTelemetry(new PbWriter().fixed32(1, 1234).message(2, new PbWriter().uint(1, 101)).finish())
    expect(t).toEqual({ time: 1234, deviceMetrics: { batteryLevel: 101 } })
  })

  it('decodes route discovery with packed and unpacked fields', () => {
    const route = new Uint8Array(8)
    new DataView(route.buffer).setUint32(0, 0x11111111, true)
    new DataView(route.buffer).setUint32(4, 0x22222222, true)
    const snrPacked = new PbWriter().int32(1, -24).int32(1, 40).finish()
    const rd = new PbWriter()
      .bytes(1, route)
      .bytes(2, Uint8Array.from([...snrPacked.subarray(1, 11), ...snrPacked.subarray(12)]))
      .fixed32(3, 0x33333333)
      .int32(4, -8)
    expect(decodeRouteDiscovery(rd.finish())).toEqual({
      route: [0x11111111, 0x22222222],
      snrTowards: [-24, 40],
      routeBack: [0x33333333],
      snrBack: [-8],
    })
    const routing = decodeRouting(new PbWriter().message(2, rd).uint(3, 5).finish())
    expect(routing.routeReply!.route).toHaveLength(2)
    expect(routing.errorReason).toBe(5)
  })

  it('decodes a mesh packet', () => {
    const data = new PbWriter().uint(1, Port.TEXT).bytes(2, new TextEncoder().encode('hi')).fixed32(6, 77).fixed32(8, 0x1f600)
    const pkt = new PbWriter()
      .fixed32(1, 0xa1b2c3d4)
      .fixed32(2, BROADCAST)
      .uint(3, 1)
      .message(4, data)
      .fixed32(6, 0xcafef00d)
      .fixed32(7, 1_700_000_000)
      .fixed32(8, f32(-3.5))
      .uint(9, 2)
      .int32(12, -95)
      .uint(15, 3)
      .uint(19, 0xd4)
    const p = decodeMeshPacket(pkt.finish())
    expect(p).toMatchObject({ from: 0xa1b2c3d4, to: BROADCAST, channel: 1, id: 0xcafef00d, rxTime: 1_700_000_000, rxSnr: -3.5 })
    expect(p).toMatchObject({ hopLimit: 2, rxRssi: -95, hopStart: 3, relayNode: 0xd4 })
    expect(p.decoded).toMatchObject({ portnum: Port.TEXT, requestId: 77, emoji: 0x1f600 })
    expect(new TextDecoder().decode(p.decoded!.payload)).toBe('hi')
  })
})

describe('ToRadio encoders', () => {
  const top = (b: Uint8Array) => [...fields(b)]

  it('want_config_id', () => {
    const [f] = top(toRadioWantConfig(0x1234567))
    expect([f.no, f.value]).toEqual([3, 0x1234567])
  })

  it('heartbeat and disconnect', () => {
    const [h] = top(toRadioHeartbeat(9))
    expect(h.no).toBe(7)
    expect(asUint([...fields(asBytes(h.value))][0].value)).toBe(9)
    expect([...toRadioDisconnect()]).toEqual([0x20, 0x01])
  })

  it('packet round-trips through decodeMeshPacket', () => {
    const b = toRadioPacket({ to: BROADCAST, channel: 2, id: 0x80000001, wantAck: true, hopLimit: 3, portnum: Port.TEXT, payload: Uint8Array.of(0x68), wantResponse: true })
    const [f] = top(b)
    expect(f.no).toBe(1)
    const p = decodeMeshPacket(asBytes(f.value))
    expect(p).toMatchObject({ from: 0, to: BROADCAST, channel: 2, id: 0x80000001, wantAck: true, hopLimit: 3 })
    expect(p.decoded).toMatchObject({ portnum: Port.TEXT, payload: Uint8Array.of(0x68), wantResponse: true })
  })

  it('packet omits zero channel, ack and hop limit', () => {
    const p = decodeMeshPacket(asBytes([...fields(toRadioPacket({ to: 5, channel: 0, id: 1, wantAck: false, portnum: 1, payload: new Uint8Array() }))][0].value))
    expect(p.wantAck).toBeUndefined()
    expect(p.hopLimit).toBeUndefined()
    expect(p.decoded!.wantResponse).toBeUndefined()
  })

  it('position round-trips with negative coordinates and altitude', () => {
    const p = decodePosition(encodePosition({ lat: -33.8688, lon: -151.2093, alt: -4 }))
    expect(p.lat).toBeCloseTo(-33.8688, 6)
    expect(p.lon).toBeCloseTo(-151.2093, 6)
    expect(p.alt).toBe(-4)
    expect(Math.abs(p.time! - Date.now() / 1000)).toBeLessThan(5)
  })

  it('telemetry request and admin uint', () => {
    expect([...encodeTelemetryRequest()]).toEqual([0x12, 0x00])
    const [f] = [...fields(encodeAdminUint(39, 0xdeadbeef))]
    expect([f.no, f.value]).toEqual([39, 0xdeadbeef])
  })
})

describe('decodeNeighborInfo', () => {
  it('reads reporter and neighbours, rounding SNR to quarter dB', () => {
    const nb = (id: number, snr: number) => new PbWriter().uint(1, id).fixed32(2, f32(snr))
    const b = new PbWriter().uint(1, 0x11223344).uint(3, 21600).message(4, nb(0xaabbccdd, 6.27)).message(4, nb(0x01020304, -3.5)).finish()
    expect(decodeNeighborInfo(b)).toEqual({
      nodeId: 0x11223344,
      neighbors: [
        { nodeId: 0xaabbccdd, snr: 6.25 },
        { nodeId: 0x01020304, snr: -3.5 },
      ],
    })
  })

  it('drops the zero-id dummy neighbour and accepts an empty payload', () => {
    const b = new PbWriter().uint(1, 5).message(4, new PbWriter().uint(1, 0)).finish()
    expect(decodeNeighborInfo(b).neighbors).toEqual([])
    expect(decodeNeighborInfo(new Uint8Array())).toEqual({ nodeId: 0, neighbors: [] })
  })
})
