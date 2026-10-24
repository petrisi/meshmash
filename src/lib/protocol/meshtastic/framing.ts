// Meshtastic serial stream framing: 0x94 0xC3 <len hi> <len lo> <protobuf>.
// Bytes outside frames are device console output and are surfaced as text lines.

export const START1 = 0x94
export const START2 = 0xc3
const MAX_LEN = 512

export type StreamItem = { type: 'frame'; payload: Uint8Array } | { type: 'text'; text: string }

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4)
  out[0] = START1
  out[1] = START2
  out[2] = payload.length >> 8
  out[3] = payload.length & 0xff
  out.set(payload, 4)
  return out
}

/** Wake sequence sent before the first frame so a sleeping serial API notices us. */
export const WAKE = new Uint8Array(32).fill(START2)

export class FrameDecoder {
  private buf: number[] = []
  private text: number[] = []
  private textDecoder = new TextDecoder()

  push(chunk: Uint8Array): StreamItem[] {
    const out: StreamItem[] = []
    for (const b of chunk) this.buf.push(b)
    for (;;) {
      const start = this.findStart()
      // Everything before a frame start (or all of it, keeping a possible partial
      // start byte) is console text.
      const textEnd = start < 0 ? (this.buf.at(-1) === START1 ? this.buf.length - 1 : this.buf.length) : start
      if (textEnd > 0) this.takeText(this.buf.splice(0, textEnd), out)
      if (start < 0 || this.buf.length < 4) break
      const len = (this.buf[2] << 8) | this.buf[3]
      if (len > MAX_LEN) {
        // Not a real header; treat the marker bytes as text and rescan.
        this.takeText(this.buf.splice(0, 2), out)
        continue
      }
      if (this.buf.length < 4 + len) break
      const frame = this.buf.splice(0, 4 + len)
      out.push({ type: 'frame', payload: Uint8Array.from(frame.slice(4)) })
    }
    return out
  }

  private findStart(): number {
    for (let i = 0; i + 1 < this.buf.length; i++) if (this.buf[i] === START1 && this.buf[i + 1] === START2) return i
    return -1
  }

  private takeText(bytes: number[], out: StreamItem[]) {
    for (const b of bytes) {
      if (b === 0x0a) {
        const line = this.textDecoder.decode(Uint8Array.from(this.text)).replace(/\r$/, '')
        this.text = []
        if (line.trim()) out.push({ type: 'text', text: line })
      } else if (b !== START2 || this.text.length) {
        this.text.push(b)
      }
    }
  }
}
