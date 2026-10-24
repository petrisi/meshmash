import { describe, expect, it } from 'vitest'
import { LeWriter } from '../src/lib/protocol/bytes'
import {
  cmdBinaryReq,
  cmdLogin,
  cmdSendCli,
  cmdStatusReq,
  cmdTelemetryReq,
  cmdTracePath,
  decodeBinaryResponse,
  decodeLoginSuccess,
  decodeLpp,
  decodeNeighbours,
  decodeStatus,
  decodeTraceData,
  NEIGHBOURS_PER_PAGE,
  neighboursReq,
  pushPrefix,
  RemoteCmd,
  ReqType,
  type Field,
} from '../src/lib/protocol/meshcore/remote'

const PK = Uint8Array.from({ length: 32 }, (_, i) => i)
const PREFIX = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6]
const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff]
const be24 = (v: number) => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
const lpp = (...recs: number[][]) => Uint8Array.from(recs.flat())

describe('decodeLpp', () => {
  it('decodes signed temperature and voltage', () => {
    const r = decodeLpp(lpp([1, 103, ...be16(-125)], [1, 116, ...be16(-100)], [1, 116, ...be16(412)]))
    expect(r.map((x) => x.value)).toEqual(['-12.5 °C', '-1.00 V', '4.12 V'])
    expect(r[0]).toMatchObject({ channel: 1, type: 103, name: 'Temperature' })
  })

  it('halves humidity', () => {
    expect(decodeLpp(lpp([2, 104, 101]))[0].value).toBe('50.5 %')
  })

  it('decodes GPS as three signed 24-bit values', () => {
    const [g] = decodeLpp(lpp([1, 136, ...be24(601699), ...be24(-249384), ...be24(-1234)]))
    expect(g.name).toBe('GPS')
    expect(g.value).toBe('60.1699, -24.9384, -12 m')
  })

  it('decodes multi-part accelerometer and colour', () => {
    const r = decodeLpp(lpp([3, 113, ...be16(-1000), ...be16(0), ...be16(1500)], [3, 135, 0xff, 0x00, 0x10]))
    expect(r.map((x) => x.value)).toEqual(['-1.000, 0.000, 1.500 G', '#ff0010'])
  })

  it('stops at an unknown type', () => {
    const r = decodeLpp(lpp([1, 103, ...be16(200)], [1, 250, 1, 2], [2, 104, 80]))
    expect(r).toHaveLength(1)
  })

  it('stops at channel 0', () => {
    const r = decodeLpp(lpp([1, 103, ...be16(200)], [0, 0, 0, 0], [2, 104, 80]))
    expect(r).toHaveLength(1)
  })

  it('stops at a truncated record', () => {
    expect(decodeLpp(lpp([1, 103, ...be16(200)], [1, 136, 0, 0]))).toHaveLength(1)
    expect(decodeLpp(new Uint8Array())).toEqual([])
  })
})

const base = (w: LeWriter) =>
  w
    .u16(4120) // mV
    .u16(3) // queue
    .u16(-110 & 0xffff) // noise
    .u16(-80 & 0xffff) // rssi
    .u32(1000) // recv
    .u32(500) // sent
    .u32(3600) // air tx
    .u32(90061) // uptime
    .u32(10)
    .u32(20)
    .u32(30)
    .u32(40)
    .u16(0x5) // err flags
    .u16(-30 & 0xffff) // snr x4
    .u16(7)
    .u16(8)

const statusFrame = (tail: (w: LeWriter) => LeWriter) => tail(base(new LeWriter().u8(0x87).u8(0).bytes(PREFIX))).finish()
const byLabel = (f: Field[]) => Object.fromEntries(f.map((x) => [x.label, x.value]))

describe('decodeStatus', () => {
  it('decodes the 56-byte repeater struct', () => {
    const f = statusFrame((w) => w.u32(7200).u32(9))
    expect(f.length).toBe(8 + 56)
    const s = byLabel(decodeStatus(f, false))
    expect(s).toMatchObject({
      Battery: '4.12 V',
      Uptime: '1d 1h',
      'Noise floor': '-110 dBm',
      'Last RSSI / SNR': '-80 dBm / -7.5 dB',
      'Packets rx / tx': '1000 / 500',
      'Rx flood / direct': '30 / 40',
      'Tx flood / direct': '10 / 20',
      'Duplicates flood / direct': '8 / 7',
      'Tx queue': '3',
      'Error flags': '0x5',
      'Receive errors': '9',
    })
    expect(s['Airtime tx']).toBe('1h 0m (4.0%)')
    expect(s['Airtime rx']).toBe('2h 0m (8.0%)')
    expect(s['Posts stored / pushed']).toBeUndefined()
  })

  it('decodes the 52-byte room struct', () => {
    const f = statusFrame((w) => w.u16(12).u16(34))
    expect(f.length).toBe(8 + 52)
    const s = byLabel(decodeStatus(f, true))
    expect(s['Posts stored / pushed']).toBe('12 / 34')
    expect(s['Airtime rx']).toBeUndefined()
  })

  it('decodes the 48-byte base struct from older servers', () => {
    const s = byLabel(decodeStatus(statusFrame((w) => w), false))
    expect(s.Battery).toBe('4.12 V')
    expect(s['Airtime rx']).toBeUndefined()
  })

  it('shows a dash for 0 mV and omits zero error flags', () => {
    const f = statusFrame((w) => w)
    f[8] = f[9] = 0
    f[8 + 40] = f[8 + 41] = 0
    const s = byLabel(decodeStatus(f, false))
    expect(s.Battery).toBe('—')
    expect(s['Error flags']).toBeUndefined()
  })
})

describe('decodeNeighbours', () => {
  it('reads entries and stops at the end of the body', () => {
    const body = new LeWriter()
      .u16(25)
      .u16(3)
      .bytes([1, 2, 3, 4, 5, 6])
      .u32(60)
      .u8(-20 & 0xff)
      .bytes([7, 8, 9, 10, 11, 12])
      .u32(3600)
      .u8(40)
      .finish()
    expect(decodeNeighbours(body)).toEqual({
      total: 25,
      list: [
        { prefix: '010203040506', heardSecsAgo: 60, snr: -5 },
        { prefix: '0708090a0b0c', heardSecsAgo: 3600, snr: 10 },
      ],
    })
  })
})

describe('decodeTraceData', () => {
  it('decodes 1-byte hashes', () => {
    const f = new LeWriter().u8(0x89).u8(0).u8(3).u8(0).u32(0xabcdef01).u32(0).bytes([0x11, 0x22, 0x33]).bytes([20, -8 & 0xff, 4]).u8(-2 & 0xff).finish()
    expect(f.length).toBe(13 + 3 + 3)
    expect(decodeTraceData(f)).toEqual({ tag: 0xabcdef01, hashes: Uint8Array.of(0x11, 0x22, 0x33), snrs: [5, -2, 1], finalSnr: -0.5 })
  })

  it('decodes 2-byte hashes (flags & 3 = 1)', () => {
    const f = new LeWriter().u8(0x89).u8(0).u8(4).u8(1).u32(7).u32(0).bytes([1, 2, 3, 4]).bytes([8, 12]).u8(16).finish()
    expect(decodeTraceData(f)).toMatchObject({ tag: 7, snrs: [2, 3], finalSnr: 4 })
  })
})

describe('decodeLoginSuccess', () => {
  it('decodes the 14-byte reply', () => {
    const f = new LeWriter().u8(0x85).u8(1).bytes(PREFIX).u32(1_700_000_000).u8(3).u8(2).finish()
    expect(f.length).toBe(14)
    expect(decodeLoginSuccess(f)).toEqual({ prefix: 'a1a2a3a4a5a6', role: 'admin', serverTime: 1_700_000_000, fwLevel: 2 })
    f[12] = 1
    expect(decodeLoginSuccess(f).role).toBe('read-only')
    f[12] = 0
    expect(decodeLoginSuccess(f).role).toBe('guest')
  })

  it('decodes the legacy 8-byte reply', () => {
    expect(decodeLoginSuccess(Uint8Array.of(0x85, 1, ...PREFIX))).toEqual({ prefix: 'a1a2a3a4a5a6', role: 'admin' })
    expect(decodeLoginSuccess(Uint8Array.of(0x85, 0, ...PREFIX))).toEqual({ prefix: 'a1a2a3a4a5a6', role: 'guest' })
  })

  it('pushPrefix reads bytes 2..8', () => {
    expect(pushPrefix(Uint8Array.of(0x86, 0, ...PREFIX))).toBe('a1a2a3a4a5a6')
  })
})

describe('command builders', () => {
  it('cmdLogin truncates the password to 15 bytes', () => {
    const c = cmdLogin(PK, 'abcdefghijklmnopqrstuvwxyz')
    expect(c.length).toBe(1 + 32 + 15)
    expect(c[0]).toBe(RemoteCmd.SEND_LOGIN)
    expect(c.subarray(1, 33)).toEqual(PK)
    expect(new TextDecoder().decode(c.subarray(33))).toBe('abcdefghijklmno')
    expect(cmdLogin(PK, '').length).toBe(33)
  })

  it('neighboursReq layout', () => {
    const r = neighboursReq(300)
    expect(r.length).toBe(11)
    expect([...r.subarray(0, 7)]).toEqual([ReqType.GET_NEIGHBOURS, 0, NEIGHBOURS_PER_PAGE, 0x2c, 0x01, 2, 6])
    expect(NEIGHBOURS_PER_PAGE).toBe(11)
    // 4 random bytes for packet-hash uniqueness.
    expect(neighboursReq(0).subarray(7)).not.toEqual(neighboursReq(0).subarray(7))
  })

  it('other request layouts', () => {
    expect([...cmdStatusReq(PK).subarray(0, 1)]).toEqual([RemoteCmd.SEND_STATUS_REQ])
    expect(cmdStatusReq(PK).length).toBe(33)
    expect([...cmdTelemetryReq(PK).subarray(0, 4)]).toEqual([RemoteCmd.SEND_TELEMETRY_REQ, 0, 0, 0])
    const b = cmdBinaryReq(PK, Uint8Array.of(7))
    expect([b[0], b.length, b[33]]).toEqual([RemoteCmd.SEND_BINARY_REQ, 34, 7])
    expect([...cmdTracePath(0x01020304, Uint8Array.of(0xaa, 0xbb))]).toEqual([RemoteCmd.SEND_TRACE_PATH, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0xaa, 0xbb])
    const cli = cmdSendCli(PK, 'ver')
    expect([...cli.subarray(0, 7)]).toEqual([2, 1, 0, 0, 0, 0, 0])
    expect(new TextDecoder().decode(cli.subarray(13))).toBe('ver')
  })

  it('decodeBinaryResponse splits tag and body', () => {
    expect(decodeBinaryResponse(Uint8Array.of(0x8c, 0, 4, 3, 2, 1, 9, 9))).toEqual({ tag: 0x01020304, body: Uint8Array.of(9, 9) })
  })
})
