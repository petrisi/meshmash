import { describe, expect, it } from 'vitest'
import { concat, utf8Encode } from '../src/lib/protocol/bytes'
import { encodeFrame as mcFrame, FrameDecoder as McDecoder } from '../src/lib/protocol/meshcore/codec'
import { encodeFrame, FrameDecoder, WAKE } from '../src/lib/protocol/meshtastic/framing'
import { mcIn } from './helpers'

type Pushable<T> = { push(c: Uint8Array): T[] }
const pushAll = <T>(d: Pushable<T>, chunks: Uint8Array[]) => chunks.flatMap((c) => d.push(c))
const bytewise = (b: Uint8Array) => Array.from(b, (x) => Uint8Array.of(x))

describe('Meshtastic FrameDecoder', () => {
  const payload = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff)

  it('encodes the 4-byte header', () => {
    expect([...encodeFrame(payload).subarray(0, 4)]).toEqual([0x94, 0xc3, 0x01, 0x2c])
  })

  it('reassembles a frame delivered one byte at a time', () => {
    expect(pushAll(new FrameDecoder(), bytewise(encodeFrame(payload)))).toEqual([{ type: 'frame', payload }])
  })

  it('reassembles frames split at arbitrary chunk boundaries', () => {
    const a = Uint8Array.of(1, 2, 3)
    const b = Uint8Array.of(0x94, 0xc3, 0x94)
    const stream = concat(encodeFrame(a), encodeFrame(b), encodeFrame(payload))
    for (let cut = 1; cut < 20; cut++) {
      const items = pushAll(new FrameDecoder(), [stream.subarray(0, cut), stream.subarray(cut)])
      expect(items).toEqual([
        { type: 'frame', payload: a },
        { type: 'frame', payload: b },
        { type: 'frame', payload },
      ])
    }
  })

  it('splits interleaved console text into lines and strips ANSI colors', () => {
    const stream = concat(
      utf8Encode('\x1b[34mDEBUG | 12:00:00 1 hello\x1b[0m\r\n'),
      encodeFrame(Uint8Array.of(8, 1)),
      utf8Encode('INFO  | split '),
      encodeFrame(Uint8Array.of(8, 2)),
      utf8Encode('line\n\r\n'),
    )
    expect(pushAll(new FrameDecoder(), bytewise(stream))).toEqual([
      { type: 'text', text: 'DEBUG | 12:00:00 1 hello' },
      { type: 'frame', payload: Uint8Array.of(8, 1) },
      { type: 'frame', payload: Uint8Array.of(8, 2) },
      { type: 'text', text: 'INFO  | split line' },
    ])
  })

  it('treats a header with an impossible length as text and resyncs', () => {
    const p = Uint8Array.of(0x10, 0x05)
    const stream = concat(Uint8Array.of(0x94, 0xc3, 0xff, 0xff), encodeFrame(p), utf8Encode('\n'))
    const items = new FrameDecoder().push(stream)
    expect(items.filter((i) => i.type === 'frame')).toEqual([{ type: 'frame', payload: p }])
  })

  it('drops leading 0xC3 wake bytes', () => {
    const p = Uint8Array.of(0x38, 0x01)
    expect(pushAll(new FrameDecoder(), [WAKE, utf8Encode('\n'), WAKE, encodeFrame(p)])).toEqual([
      { type: 'frame', payload: p },
    ])
  })

  it('holds a trailing 0x94 until the next chunk', () => {
    const p = Uint8Array.of(1)
    const f = encodeFrame(p)
    const d = new FrameDecoder()
    expect(d.push(concat(utf8Encode('x'), f.subarray(0, 1)))).toEqual([])
    expect(d.push(concat(f.subarray(1), utf8Encode('\n')))).toEqual([
      { type: 'frame', payload: p },
      { type: 'text', text: 'x' },
    ])
  })

  it('accepts an empty frame', () => {
    expect(new FrameDecoder().push(encodeFrame(new Uint8Array()))).toEqual([{ type: 'frame', payload: new Uint8Array() }])
  })
})

describe('MeshCore FrameDecoder', () => {
  it('encodes app→radio frames with a little-endian length', () => {
    expect([...mcFrame(new Uint8Array(258)).subarray(0, 3)]).toEqual([0x3c, 0x02, 0x01])
  })

  it('reassembles a frame delivered one byte at a time', () => {
    const p = Uint8Array.from({ length: 200 }, (_, i) => i)
    const items = pushAll(new McDecoder(), bytewise(mcIn(p)))
    expect(items).toEqual([{ type: 'frame', payload: p }])
  })

  it('reassembles back-to-back frames across chunk boundaries', () => {
    const a = Uint8Array.of(13, 3)
    const b = Uint8Array.of(0x3e, 0x3e, 0x3e)
    const stream = concat(mcIn(a), mcIn(b), mcIn(a))
    for (let cut = 1; cut < stream.length; cut++) {
      expect(pushAll(new McDecoder(), [stream.subarray(0, cut), stream.subarray(cut)])).toEqual([
        { type: 'frame', payload: a },
        { type: 'frame', payload: b },
        { type: 'frame', payload: a },
      ])
    }
  })

  it('reports bytes before a frame as junk', () => {
    const items = new McDecoder().push(concat(utf8Encode('boot ok\r\n'), mcIn(Uint8Array.of(10))))
    expect(items[0].type).toBe('junk')
    expect(new TextDecoder().decode((items[0] as { bytes: Uint8Array }).bytes)).toBe('boot ok\r\n')
    expect(items[1]).toEqual({ type: 'frame', payload: Uint8Array.of(10) })
  })

  it('skips a start byte with a zero or oversized length', () => {
    const p = Uint8Array.of(0, 1, 2)
    for (const bad of [Uint8Array.of(0x3e, 0, 0), Uint8Array.of(0x3e, 0x2d, 0x01)]) {
      const items = new McDecoder().push(concat(bad, mcIn(p)))
      expect(items.filter((i) => i.type === 'frame')).toEqual([{ type: 'frame', payload: p }])
    }
  })

  it('waits for a partial header', () => {
    const d = new McDecoder()
    const f = mcIn(Uint8Array.of(5, 5))
    expect(d.push(f.subarray(0, 2))).toEqual([])
    expect(d.push(f.subarray(2))).toEqual([{ type: 'frame', payload: Uint8Array.of(5, 5) }])
  })
})
