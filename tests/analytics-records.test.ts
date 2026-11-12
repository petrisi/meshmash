// Analytics packet records: type groups, MeshCore repeats and senders, Meshtastic rx/tx, recorder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CoverageSpan, mcPacketType, mtPacketType, type PacketRecord, RepeatFilter, RETENTION_MS, PACKETS_CAP } from '../src/lib/model/analytics'
import { LeWriter, utf8Encode } from '../src/lib/protocol/bytes'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Push, Resp, splitPacket, TxtType } from '../src/lib/protocol/meshcore/codec'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { BROADCAST, Port } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { PbWriter } from '../src/lib/protocol/protobuf'
import { FLUSH_MS, type PacketBackend, PacketRecorder } from '../src/lib/store/packets'
import type { Transport } from '../src/lib/transport/types'
import { f32, mcIn, recordingSink } from './helpers'

describe('type groups', () => {
  it('Meshtastic ports', () => {
    expect([1, 3, 4, 5, 67, 70, 71, 6, undefined].map(mtPacketType)).toEqual([
      'text', 'position', 'nodeinfo', 'routing', 'telemetry', 'traceroute', 'neighbours', 'other', 'encrypted',
    ])
  })
  it('MeshCore payload types', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15].map(mcPacketType)).toEqual([
      'request', 'request', 'dm', 'ack', 'advert', 'channel', 'other', 'request', 'path', 'trace', 'other',
    ])
  })
})

describe('RepeatFilter', () => {
  it('flags a key seen within the window only', () => {
    const f = new RepeatFilter(1000)
    expect([f.repeat('a', 0), f.repeat('a', 500), f.repeat('b', 600), f.repeat('a', 2000)]).toEqual([false, true, false, false])
  })
})

describe('splitPacket', () => {
  it('reads transport codes, path and payload', () => {
    // Transport flood (route 0), advert, 2 hops of 2-byte hashes.
    const p = splitPacket(Uint8Array.of((4 << 2) | 0, 1, 2, 3, 4, 0x42, 0xa, 0xb, 0xc, 0xd, 0x99))
    expect(p).toMatchObject({ routeType: 0, payloadType: 4, hops: 2, payload: Uint8Array.of(0x99) })
  })
  it('rejects a reserved hash size and a short path', () => {
    expect(splitPacket(Uint8Array.of(4 << 2 | 1, 0xc1, 1, 2, 3, 4))).toBeNull()
    expect(splitPacket(Uint8Array.of(4 << 2 | 1, 3, 1))).toBeNull()
  })
})

// MeshCore: LOG_RX_DATA frames fed to the client.

const SELF = Uint8Array.from({ length: 32 }, (_, i) => 0x10 + i)
const OTHER = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)
const hex6 = (pk: Uint8Array) => [...pk.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')

function advert(pk: Uint8Array, name: string, path: number[] = [], route = 1) {
  const app = new LeWriter().u8(0x81).bytes(utf8Encode(name)).finish()
  return Uint8Array.of((4 << 2) | route, path.length, ...path, ...pk, 1, 0, 0, 0, ...new Uint8Array(64), ...app)
}

function mcSetup() {
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async () => {} }
  const rec = recordingSink()
  const records: PacketRecord[] = []
  rec.sink.packet = (r) => void records.push(r)
  const client = new MeshCoreClient(t as unknown as Transport, rec.sink)
  ;(client as unknown as { self: { publicKey: Uint8Array } }).self = { publicKey: SELF }
  const hear = (raw: Uint8Array, snr = 5, rssi = -90) => t.onData(mcIn(Uint8Array.of(Push.LOG_RX_DATA, (snr * 4) & 0xff, rssi & 0xff, ...raw)))
  /** A message frame as drained from the radio's queue. */
  const synced = (f: Uint8Array, initial: boolean) =>
    (client as unknown as { onMessageFrame(f: Uint8Array, q: boolean): void }).onMessageFrame(f, initial)
  return { records, hear, synced }
}

const ts = Math.floor(Date.now() / 1000) - 3600
const channelMsg = (text: string) =>
  new LeWriter().u8(Resp.CHANNEL_MSG_RECV_V3).u8(8).u16(0).u8(2).u8(1).u8(TxtType.PLAIN).u32(ts).bytes(utf8Encode(text)).finish()
const contactMsg = (sender: Uint8Array) =>
  new LeWriter().u8(Resp.CONTACT_MSG_RECV_V3).u8(0).u16(0).bytes(sender.subarray(0, 6)).u8(0).u8(TxtType.PLAIN).u32(ts).bytes(utf8Encode('hi')).finish()

describe('MeshCore messages held by the radio', () => {
  it('the drain at connect records them as held, at the sender time', () => {
    const { records, synced } = mcSetup()
    synced(channelMsg('Hill: hello'), true)
    synced(contactMsg(OTHER), true)
    expect(records).toEqual([
      { ts: ts * 1000, dir: 'rx', from: undefined, type: 'channel', channel: 2, hops: 1, snr: 2, name: 'Hill', queued: true },
      { ts: ts * 1000, dir: 'rx', from: hex6(OTHER), type: 'dm', channel: undefined, hops: 0, snr: 0, name: undefined, queued: true },
    ])
  })

  it('later drains are not recorded: their raw packets already were', () => {
    const { records, synced } = mcSetup()
    synced(channelMsg('Hill: hello'), false)
    expect(records).toEqual([])
  })
})

describe('MeshCore received packets', () => {
  it('records an advert with sender, name, hops and signal', () => {
    const { records, hear } = mcSetup()
    hear(advert(OTHER, 'Hill', [0xaa, 0xbb]), -2.5, -101)
    expect(records).toEqual([
      { ts: expect.any(Number), dir: 'rx', from: hex6(OTHER), type: 'advert', hops: 2, snr: -2.5, rssi: -101, name: 'Hill', dup: undefined },
    ])
  })

  it('marks the same packet heard via another path as a repeat', () => {
    const { records, hear } = mcSetup()
    hear(advert(OTHER, 'Hill', [0xaa]))
    hear(advert(OTHER, 'Hill', [0xaa, 0xcc]))
    expect(records.map((r) => [r.hops, r.dup])).toEqual([[1, undefined], [2, true]])
  })

  it('skips our own advert heard back', () => {
    const { records, hear } = mcSetup()
    hear(advert(SELF, 'Me', [0xaa]))
    expect(records).toEqual([])
  })

  it('takes the sender of an anonymous request from its public key; others have none', () => {
    const { records, hear } = mcSetup()
    hear(Uint8Array.of((7 << 2) | 1, 0, 0x55, ...OTHER, 1, 2, 3))
    hear(Uint8Array.of((11 << 2) | 2, 0, 0x92, 20, 1, 2, 3, 4, ...OTHER.subarray(0, 8))) // discover reply, key prefix
    hear(Uint8Array.of((2 << 2) | 2, 0, 0x55, 0x66, 9, 9, 9)) // direct TXT_MSG: no hop count
    expect(records.map((r) => [r.type, r.from, r.hops])).toEqual([
      ['request', hex6(OTHER), 0],
      ['other', hex6(OTHER), undefined],
      ['dm', undefined, undefined],
    ])
  })
})

// Meshtastic.

const FROM = 0x11223344

function mtSetup() {
  const writes: Uint8Array[] = []
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async (b: Uint8Array) => void writes.push(b) }
  const rec = recordingSink()
  const records: PacketRecord[] = []
  rec.sink.packet = (r) => void records.push(r)
  const client = new MeshtasticClient(t as unknown as Transport, rec.sink)
  const receive = (port: number, payload: Uint8Array, rssi = -95, agoS = 0) => {
    const data = new PbWriter().uint(1, port).bytes(2, payload)
    const p = new PbWriter().fixed32(1, FROM).fixed32(2, BROADCAST).message(4, data).fixed32(6, 7)
      .fixed32(8, f32(4.5)).uint(9, 2).uint(15, 3)
    if (agoS) p.fixed32(7, Math.floor(Date.now() / 1000) - agoS)
    if (rssi) p.int32(12, rssi)
    t.onData(encodeFrame(new PbWriter().message(2, p).finish()))
  }
  return { client, records, receive }
}

describe('Meshtastic packets', () => {
  it('records a received packet with type, hops, signal and node info name', () => {
    const { records, receive } = mtSetup()
    receive(Port.NODEINFO, new PbWriter().string(2, 'Hill Top').finish())
    expect(records).toEqual([
      { ts: expect.any(Number), dir: 'rx', from: '!11223344', type: 'nodeinfo', channel: 0, hops: 1, snr: 4.5, rssi: -95, mqtt: undefined, name: 'Hill Top', queued: undefined },
    ])
  })

  it('marks a packet received well before the connection as held by the radio', () => {
    const { records, receive } = mtSetup()
    receive(Port.TEXT, utf8Encode('hi'), -95, 600)
    receive(Port.TEXT, utf8Encode('hi'), -95, 10)
    expect(records.map((r) => r.queued)).toEqual([true, undefined])
  })

  it('records a sent packet', async () => {
    const { client, records } = mtSetup()
    await client.sendText('ch:0', 'hi', 'a')
    expect(records).toMatchObject([{ dir: 'tx', type: 'text', channel: 0 }])
  })
})

// Recorder.

function memory() {
  const added: PacketRecord[][] = []
  const spans: CoverageSpan[] = []
  const pruned: [number, number][] = []
  const backend: PacketBackend = {
    add: async (_r, recs) => void added.push(recs),
    coverage: async (_r, s) => void spans.push(s),
    prune: async (_r, before, cap) => void pruned.push([before, cap]),
  }
  return { backend, added, spans, pruned }
}

describe('PacketRecorder', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const rec = (ts: number): PacketRecord => ({ ts, dir: 'rx', type: 'text' })

  it('keeps records from before start, writes in batches, extends coverage', async () => {
    const m = memory()
    let now = 1_000_000
    const r = new PacketRecorder(m.backend, () => now)
    r.add(rec(1))
    r.start('radio')
    await vi.advanceTimersByTimeAsync(0)
    expect(m.pruned).toEqual([[now - RETENTION_MS, PACKETS_CAP]])
    expect(m.added).toEqual([[rec(1)]])
    r.add(rec(2))
    r.add(rec(3))
    now += FLUSH_MS
    await vi.advanceTimersByTimeAsync(FLUSH_MS)
    expect(m.added.at(-1)).toEqual([rec(2), rec(3)])
    expect(m.spans.at(-1)).toEqual({ start: 1_000_000, end: now })
  })

  it('stop writes what is left and frees the recorder for the next radio', async () => {
    const m = memory()
    const r = new PacketRecorder(m.backend, () => 5)
    r.start('a')
    r.add(rec(1))
    const written = r.stop()
    r.add(rec(2)) // a new session's record, before its start
    await written
    expect(m.added.flat()).toEqual([rec(1)])
  })

  it('without start nothing is written', async () => {
    const m = memory()
    const r = new PacketRecorder(m.backend)
    r.add(rec(1))
    await r.stop()
    expect(m.added).toEqual([])
  })
})
