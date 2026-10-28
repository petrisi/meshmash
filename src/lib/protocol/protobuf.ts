// Minimal protobuf wire-format codec. Messages are decoded field-by-field by the caller;
// there is no schema compilation.

export const enum WireType {
  Varint = 0,
  I64 = 1,
  Len = 2,
  I32 = 5,
}

export interface Field {
  no: number
  type: WireType
  /** Varint: low 53 bits as a number. I32/I64: raw bytes. Len: payload bytes. */
  value: number | Uint8Array
}

export class PbReader {
  pos = 0
  constructor(readonly buf: Uint8Array) {}

  /**
   * Reads a varint. Up to 7 bytes (49 bits) is exact as a number. Longer varints are
   * 64-bit values — in our messages only negative int32/int64 — and are returned as a
   * signed 64-bit value.
   */
  varint(): number {
    let result = 0
    let mul = 1
    const start = this.pos
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new RangeError('truncated varint')
      const b = this.buf[this.pos++]
      if (i === 7) {
        this.pos = start
        return this.varint64()
      }
      result += (b & 0x7f) * mul
      if (!(b & 0x80)) return result
      mul *= 128
    }
    throw new RangeError('varint too long')
  }

  private varint64(): number {
    let x = 0n
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (this.pos >= this.buf.length) throw new RangeError('truncated varint')
      const b = this.buf[this.pos++]
      x |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return Number(BigInt.asIntN(64, x))
    }
    throw new RangeError('varint too long')
  }

  bytes(n: number): Uint8Array {
    // A negative length (a 64-bit varint) would move pos backwards and loop forever.
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('bad field length')
    if (this.pos + n > this.buf.length) throw new RangeError('truncated field')
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }

  *fields(): Generator<Field> {
    while (this.pos < this.buf.length) {
      const key = this.varint()
      const no = Math.floor(key / 8)
      const type = (key & 7) as WireType
      switch (type) {
        case WireType.Varint:
          yield { no, type, value: this.varint() }
          break
        case WireType.I64:
          yield { no, type, value: this.bytes(8) }
          break
        case WireType.Len:
          yield { no, type, value: this.bytes(this.varint()) }
          break
        case WireType.I32:
          yield { no, type, value: this.bytes(4) }
          break
        default:
          throw new Error(`unsupported wire type ${type}`)
      }
    }
  }
}

export function* fields(buf: Uint8Array): Generator<Field> {
  yield* new PbReader(buf).fields()
}

// Field value interpreters.

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength)

export const asUint = (v: Field['value']) => v as number
export const asBool = (v: Field['value']) => (v as number) !== 0
/** int32 varint; negative values are already sign-decoded by the reader. */
export const asInt32 = (v: Field['value']) => {
  const n = v as number
  return n >= 2 ** 31 && n < 2 ** 32 ? n - 2 ** 32 : n
}
export const asSint = (v: Field['value']) => {
  const n = v as number
  return n % 2 ? -(n + 1) / 2 : n / 2
}
export const asFixed32 = (v: Field['value']) => dv(v as Uint8Array).getUint32(0, true)
export const asSfixed32 = (v: Field['value']) => dv(v as Uint8Array).getInt32(0, true)
export const asFloat = (v: Field['value']) => dv(v as Uint8Array).getFloat32(0, true)
export const asBytes = (v: Field['value']) => v as Uint8Array
export const asString = (v: Field['value']) => new TextDecoder().decode(v as Uint8Array)

/** Packed or unpacked repeated fixed32 / varint values. */
export function repeatedFixed32(v: Field['value'], type: WireType): number[] {
  if (type === WireType.I32) return [asFixed32(v)]
  const b = v as Uint8Array
  const out: number[] = []
  for (let i = 0; i + 4 <= b.length; i += 4) out.push(dv(b).getUint32(i, true))
  return out
}

export function repeatedInt32(v: Field['value'], type: WireType): number[] {
  if (type === WireType.Varint) return [asInt32(v)]
  const r = new PbReader(v as Uint8Array)
  const out: number[] = []
  while (r.pos < r.buf.length) out.push(asInt32(r.varint()))
  return out
}

export class PbWriter {
  private out: number[] = []

  private raw(n: number) {
    // n is a non-negative integer below 2^53.
    while (n >= 128) {
      this.out.push((n % 128) | 0x80)
      n = Math.floor(n / 128)
    }
    this.out.push(n)
  }

  private key(no: number, type: WireType) {
    this.raw(no * 8 + type)
  }

  uint(no: number, v: number) {
    this.key(no, WireType.Varint)
    this.raw(v)
    return this
  }

  int32(no: number, v: number) {
    // Negative int32 is sign-extended to 64 bits on the wire.
    if (v >= 0) return this.uint(no, v)
    this.key(no, WireType.Varint)
    let x = BigInt.asUintN(64, BigInt(v))
    while (x >= 128n) {
      this.out.push(Number(x & 127n) | 0x80)
      x >>= 7n
    }
    this.out.push(Number(x))
    return this
  }

  bool(no: number, v: boolean) {
    return this.uint(no, v ? 1 : 0)
  }

  fixed32(no: number, v: number) {
    this.key(no, WireType.I32)
    for (let i = 0; i < 4; i++) this.out.push((v >>> (8 * i)) & 0xff)
    return this
  }

  bytes(no: number, b: Uint8Array) {
    this.key(no, WireType.Len)
    this.raw(b.length)
    for (const x of b) this.out.push(x)
    return this
  }

  string(no: number, s: string) {
    return this.bytes(no, new TextEncoder().encode(s))
  }

  /** Re-encodes a decoded field unchanged (varints below 2^53). */
  field(f: Field) {
    if (f.type === WireType.Len) return this.bytes(f.no, f.value as Uint8Array)
    if (f.type === WireType.Varint) return this.uint(f.no, f.value as number)
    this.key(f.no, f.type)
    for (const x of f.value as Uint8Array) this.out.push(x)
    return this
  }

  message(no: number, w: PbWriter) {
    return this.bytes(no, w.finish())
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out)
  }
}
