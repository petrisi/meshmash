import { describe, expect, it } from 'vitest'
import {
  asBool,
  asBytes,
  asFixed32,
  asFloat,
  asInt32,
  asSfixed32,
  asSint,
  asString,
  asUint,
  fields,
  PbReader,
  PbWriter,
  repeatedFixed32,
  repeatedInt32,
  WireType,
} from '../src/lib/protocol/protobuf'
import { f32 } from './helpers'

const all = (b: Uint8Array) => [...fields(b)]

describe('PbWriter / PbReader', () => {
  it('round-trips unsigned varints up to 2^53', () => {
    for (const v of [0, 1, 127, 128, 300, 2 ** 32 - 1, 2 ** 49 - 1, 2 ** 49, 2 ** 50 + 3, 2 ** 53 - 1]) {
      const [f] = all(new PbWriter().uint(1, v).finish())
      expect(f.type).toBe(WireType.Varint)
      expect(asUint(f.value)).toBe(v)
    }
  })

  it('encodes negative int32 as a 10-byte varint and decodes it back', () => {
    const b = new PbWriter().int32(2, -1).finish()
    expect([...b]).toEqual([0x10, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    for (const v of [-1, -2, -128, -2147483648, 0, 5, 2147483647]) {
      const [f] = all(new PbWriter().int32(1, v).finish())
      expect(asInt32(f.value)).toBe(v)
    }
  })

  it('reads an int32 sent as a 5-byte uint32 varint as negative', () => {
    const [f] = all(new PbWriter().uint(1, 0xfffffffe).finish())
    expect(asInt32(f.value)).toBe(-2)
  })

  it('round-trips fixed32 / sfixed32 / float', () => {
    const b = new PbWriter().fixed32(1, 0xffffffff).fixed32(2, -5 >>> 0).fixed32(3, f32(-1.5)).finish()
    const [a, s, fl] = all(b)
    expect(a.type).toBe(WireType.I32)
    expect(asFixed32(a.value)).toBe(0xffffffff)
    expect(asSfixed32(a.value)).toBe(-1)
    expect(asSfixed32(s.value)).toBe(-5)
    expect(asFloat(fl.value)).toBe(-1.5)
  })

  it('round-trips strings, bools, bytes and nested messages', () => {
    const inner = new PbWriter().string(1, 'häst 🐴').bool(2, true).int32(3, -7)
    const b = new PbWriter().uint(1, 42).message(2, inner).bytes(3, Uint8Array.of(1, 2, 3)).finish()
    const f = all(b)
    expect(f.map((x) => x.no)).toEqual([1, 2, 3])
    expect(f[1].type).toBe(WireType.Len)
    const g = all(asBytes(f[1].value))
    expect(asString(g[0].value)).toBe('häst 🐴')
    expect(asBool(g[1].value)).toBe(true)
    expect(asInt32(g[2].value)).toBe(-7)
    expect([...asBytes(f[2].value)]).toEqual([1, 2, 3])
  })

  it('handles multi-byte keys', () => {
    const [f] = all(new PbWriter().uint(1000, 9).finish())
    expect(f.no).toBe(1000)
  })

  it('returns I64 fields as 8 raw bytes', () => {
    const f = all(Uint8Array.of(0x09, 1, 2, 3, 4, 5, 6, 7, 8, 0x10, 0x05))
    expect(f[0].type).toBe(WireType.I64)
    expect((f[0].value as Uint8Array).length).toBe(8)
    expect(asUint(f[1].value)).toBe(5)
  })

  it('throws on truncated input', () => {
    expect(() => all(Uint8Array.of(0x08, 0x80))).toThrow(RangeError)
    expect(() => all(Uint8Array.of(0x12, 0x05, 1, 2))).toThrow(RangeError)
    expect(() => new PbReader(new Uint8Array(9).fill(0xff)).varint()).toThrow(RangeError)
    expect(() => new PbReader(new Uint8Array(11).fill(0xff)).varint()).toThrow(RangeError)
  })

  it('throws on unsupported wire types', () => {
    expect(() => all(Uint8Array.of(0x0b))).toThrow(/wire type/)
  })
})

describe('field interpreters', () => {
  it('decodes zigzag sint', () => {
    expect([0, 1, 2, 3, 4].map(asSint)).toEqual([0, -1, 1, -2, 2])
  })

  it('reads packed and unpacked repeated fixed32', () => {
    const packed = new Uint8Array(8)
    new DataView(packed.buffer).setUint32(0, 0xdeadbeef, true)
    new DataView(packed.buffer).setUint32(4, 7, true)
    expect(repeatedFixed32(packed, WireType.Len)).toEqual([0xdeadbeef, 7])
    const [one] = all(new PbWriter().fixed32(1, 9).finish())
    expect(repeatedFixed32(one.value, one.type)).toEqual([9])
  })

  it('reads packed and unpacked repeated int32 with negatives', () => {
    // [key][10-byte -20][key][30] minus the keys is the packed form.
    const body = new PbWriter().int32(1, -20).int32(1, 30).finish()
    const packed = Uint8Array.from([...body.subarray(1, 11), ...body.subarray(12)])
    expect(repeatedInt32(packed, WireType.Len)).toEqual([-20, 30])
    const [one] = all(new PbWriter().int32(1, -3).finish())
    expect(repeatedInt32(one.value, one.type)).toEqual([-3])
  })
})
