// Feeds malformed and random frames through both protocol clients. Frames come from the
// radio, and many fields in them come from other nodes over the air, so no input may throw
// out of the client, hang it, or reject a promise unhandled.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { PbWriter } from '../src/lib/protocol/protobuf'
import type { SerialTransport } from '../src/lib/transport/serial'
import { mcIn, recordingSink, type Recorded } from './helpers'

/** Deterministic PRNG (mulberry32) so failures reproduce. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ITERATIONS = 4000

function fakePort() {
  const t = { label: 'fuzz', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async () => {} }
  return t as unknown as SerialTransport & { onData: (c: Uint8Array) => void }
}

function randomBytes(r: () => number, max: number) {
  const b = new Uint8Array(Math.floor(r() * max))
  for (let i = 0; i < b.length; i++) b[i] = Math.floor(r() * 256)
  return b
}

/** Random protobuf-shaped bytes: valid keys with random wire types, lengths and values. */
function randomProto(r: () => number, depth = 0): Uint8Array {
  const w = new PbWriter()
  const n = Math.floor(r() * 8)
  for (let i = 0; i < n; i++) {
    const no = 1 + Math.floor(r() * 20)
    const pick = r()
    if (pick < 0.3) w.uint(no, Math.floor(r() * 2 ** (r() < 0.5 ? 8 : 40)))
    else if (pick < 0.4) w.int32(no, -Math.floor(r() * 2 ** 31))
    else if (pick < 0.55) w.fixed32(no, Math.floor(r() * 2 ** 32))
    else if (pick < 0.8 && depth < 3) w.bytes(no, randomProto(r, depth + 1))
    else w.bytes(no, randomBytes(r, 40))
  }
  const out = w.finish()
  if (r() > 0.05) return out
  // A length-delimited field whose length is a negative 64-bit varint.
  const back = BigInt.asUintN(64, BigInt(-Math.floor(1 + r() * (out.length + 12))))
  const len: number[] = []
  for (let x = back; ; x >>= 7n) {
    if (x < 128n) {
      len.push(Number(x))
      break
    }
    len.push(Number(x & 127n) | 0x80)
  }
  return Uint8Array.from([...out, (1 + Math.floor(r() * 15)) * 8 + 2, ...len])
}

/** Flips, truncates, extends or splices bytes of a frame. */
function mutate(r: () => number, b: Uint8Array): Uint8Array {
  const out = Array.from(b)
  const edits = 1 + Math.floor(r() * 4)
  for (let e = 0; e < edits; e++) {
    const pick = r()
    const at = Math.floor(r() * (out.length + 1))
    if (pick < 0.4 && out.length) out[at % out.length] = Math.floor(r() * 256)
    else if (pick < 0.6) out.length = at
    else if (pick < 0.8) out.splice(at, 0, ...randomBytes(r, 12))
    else if (out.length) out[at % out.length] = [0, 0x7f, 0x80, 0xff][Math.floor(r() * 4)]
  }
  return Uint8Array.from(out)
}

const unhandled: unknown[] = []
const onUnhandled = (e: unknown) => void unhandled.push(e)
beforeAll(() => void process.on('unhandledRejection', onUnhandled))
afterAll(() => void process.off('unhandledRejection', onUnhandled))

/** Log kinds seen, so a harness change that stops reaching the handlers shows up. */
function kinds(rec: Recorded, dir: string) {
  return new Set(rec.logs.filter((l) => l.dir === dir).map((l) => l.kind))
}

function feed(t: { onData: (c: Uint8Array) => void }, frame: Uint8Array) {
  const start = performance.now()
  t.onData(frame)
  const ms = performance.now() - start
  if (ms > 200) throw new Error(`frame took ${ms.toFixed(0)} ms`)
}

describe('Meshtastic fuzz', () => {
  const PORTS = [1, 3, 4, 5, 6, 8, 32, 33, 67, 70, 71, 73]

  function packet(r: () => number) {
    const data = new PbWriter()
      .uint(1, PORTS[Math.floor(r() * PORTS.length)])
      .bytes(2, r() < 0.5 ? randomProto(r) : randomBytes(r, 80))
    if (r() < 0.3) data.fixed32(7, Math.floor(r() * 2 ** 32))
    if (r() < 0.2) data.fixed32(8, Math.floor(r() * 2 ** 32))
    const p = new PbWriter()
      .fixed32(1, Math.floor(r() * 2 ** 32))
      .fixed32(2, r() < 0.5 ? 0xffffffff : Math.floor(r() * 2 ** 32))
      .uint(3, Math.floor(r() * 10))
      .message(4, data)
      .fixed32(6, Math.floor(r() * 2 ** 32))
    return new PbWriter().uint(1, Math.floor(r() * 1000)).message(2, p).finish()
  }

  it('random and mutated FromRadio frames are contained', async () => {
    const r = rng(1)
    const t = fakePort()
    const rec = recordingSink()
    new MeshtasticClient(t, rec.sink)
    for (let i = 0; i < ITERATIONS; i++) {
      const pick = r()
      const payload =
        pick < 0.5 ? packet(r) : pick < 0.75 ? mutate(r, packet(r)) : pick < 0.9 ? randomProto(r) : randomBytes(r, 300)
      feed(t, encodeFrame(payload.subarray(0, 512)))
    }
    await new Promise((res) => setTimeout(res, 20))
    expect(unhandled).toEqual([])
    console.log('meshtastic rx', [...kinds(rec, 'rx')].join(' '), '| errors', [...kinds(rec, 'error')].join(' '), rec.nodes.size, 'nodes')
  })
})

describe('MeshCore fuzz', () => {
  const CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 16, 17, 18, 25, ...Array.from({ length: 17 }, (_, i) => 0x80 + i)]

  it('random and mutated frames are contained', async () => {
    const r = rng(2)
    const t = fakePort()
    const rec = recordingSink()
    new MeshCoreClient(t, rec.sink)
    for (let i = 0; i < ITERATIONS; i++) {
      const body = randomBytes(r, r() < 0.5 ? 16 : 200)
      const f = Uint8Array.of(CODES[Math.floor(r() * CODES.length)], ...body)
      feed(t, mcIn(r() < 0.3 ? mutate(r, f).subarray(0, 250) : f))
    }
    await new Promise((res) => setTimeout(res, 20))
    expect(unhandled).toEqual([])
    console.log('meshcore rx', [...kinds(rec, 'rx')].join(' '), '| errors', [...kinds(rec, 'error')].join(' '), rec.nodes.size, 'nodes')
  })
})
