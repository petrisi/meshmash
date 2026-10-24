const utf8 = new TextDecoder('utf-8', { fatal: false })
const utf8enc = new TextEncoder()

export function hex(b: Uint8Array, max = Infinity): string {
  let s = ''
  for (let i = 0; i < b.length && i < max; i++) s += b[i].toString(16).padStart(2, '0')
  return b.length > max ? s + '…' : s
}

export function utf8Decode(b: Uint8Array): string {
  return utf8.decode(b)
}

export function utf8Encode(s: string): Uint8Array {
  return utf8enc.encode(s)
}

/** Decodes a fixed-size, NUL-padded string field. */
export function cString(b: Uint8Array): string {
  const end = b.indexOf(0)
  return utf8.decode(end < 0 ? b : b.subarray(0, end))
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Little-endian cursor over a byte array. Reads past the end throw. */
export class LeReader {
  private view: DataView
  pos = 0

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  get remaining() {
    return this.buf.length - this.pos
  }

  u8() {
    return this.view.getUint8(this.pos++)
  }
  i8() {
    return this.view.getInt8(this.pos++)
  }
  u16() {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }
  i16() {
    const v = this.view.getInt16(this.pos, true)
    this.pos += 2
    return v
  }
  u32() {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  i32() {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  bytes(n: number) {
    if (this.pos + n > this.buf.length) throw new RangeError('read past end')
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }
  rest() {
    return this.bytes(this.remaining)
  }
  cstr(n: number) {
    return cString(this.bytes(n))
  }
}

/** Little-endian builder. */
export class LeWriter {
  private parts: number[] = []

  u8(v: number) {
    this.parts.push(v & 0xff)
    return this
  }
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff)
    return this
  }
  i32(v: number) {
    return this.u32(v >>> 0)
  }
  bytes(b: Uint8Array | number[]) {
    for (const x of b) this.parts.push(x)
    return this
  }
  finish() {
    return Uint8Array.from(this.parts)
  }
}

export function endsWith(a: Uint8Array, suffix: Uint8Array): boolean {
  if (suffix.length > a.length) return false
  const off = a.length - suffix.length
  for (let i = 0; i < suffix.length; i++) if (a[off + i] !== suffix[i]) return false
  return true
}
