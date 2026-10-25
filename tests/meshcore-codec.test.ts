import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hex, LeWriter, utf8Encode } from '../src/lib/protocol/bytes'
import {
  Cmd,
  hashtagSecret,
  isHashtagChannel,
  cmdAppStart,
  cmdDeviceQuery,
  cmdPathDiscovery,
  cmdSendChannelText,
  cmdSendText,
  cmdSetTime,
  codeName,
  decodeChannelInfo,
  decodeChannelMsg,
  decodeContact,
  decodeContactMsg,
  decodeDeviceInfo,
  decodePath,
  decodePathDiscovery,
  decodeRxLog,
  decodeSelfInfo,
  decodeSent,
  groupTextCiphertext,
  OUT_PATH_FLOOD,
  pathHops,
  Resp,
  TxtType,
} from '../src/lib/protocol/meshcore/codec'

const PK = Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i)
const padded = (s: string, n: number) => {
  const b = new Uint8Array(n)
  b.set(utf8Encode(s))
  return b
}

describe('responses', () => {
  it('decodes DEVICE_INFO', () => {
    const f = new LeWriter()
      .u8(Resp.DEVICE_INFO)
      .u8(13)
      .u8(175)
      .u8(40)
      .u32(123456)
      .bytes(padded('14 Aug 2026', 12))
      .bytes(padded('Heltec V3', 40))
      .bytes(padded('v1.17.1', 20))
      .u8(1)
      .u8(2)
      .finish()
    expect(decodeDeviceInfo(f)).toEqual({
      verCode: 13,
      maxContacts: 350,
      maxChannels: 40,
      buildDate: '14 Aug 2026',
      manufacturer: 'Heltec V3',
      firmware: 'v1.17.1',
      repeat: true,
      pathHashMode: 2,
    })
    expect(decodeDeviceInfo(Uint8Array.of(Resp.DEVICE_INFO, 2))).toEqual({ verCode: 2 })
  })

  it('decodes SELF_INFO with negative tx power', () => {
    const f = new LeWriter()
      .u8(Resp.SELF_INFO)
      .u8(1)
      .u8(-9)
      .u8(22)
      .bytes(PK)
      .i32(-33_868_800)
      .i32(151_209_300)
      .u8(0)
      .u8(1)
      .u8(2)
      .u8(0)
      .u32(869_525)
      .u32(62_500)
      .u8(8)
      .u8(8)
      .bytes(utf8Encode('Node ✈'))
      .finish()
    const s = decodeSelfInfo(f)
    expect(s).toMatchObject({ advType: 1, txPower: -9, maxTxPower: 22, lat: -33.8688, lon: 151.2093, sf: 8, cr: 8, name: 'Node ✈' })
    expect(s.freqMHz).toBeCloseTo(869.525, 6)
    expect(s.bwKHz).toBe(62.5)
    expect(s.publicKey).toEqual(PK)
  })

  const contact = (extra = true) => {
    const path = new Uint8Array(64)
    path.set([0x11, 0x22, 0x33, 0x44])
    const w = new LeWriter()
      .u8(Resp.CONTACT)
      .bytes(PK)
      .u8(2)
      .u8(1)
      .u8(0x42)
      .bytes(path)
      .bytes(padded('Hill Rptr', 32))
      .u32(1_700_000_000)
    if (extra) w.i32(60_169_900).i32(-24_938_400).u32(1_700_000_500)
    return w.finish()
  }

  it('decodes CONTACT', () => {
    const c = decodeContact(contact())
    expect(c).toMatchObject({ type: 2, flags: 1, outPathLen: 0x42, name: 'Hill Rptr', lastAdvert: 1_700_000_000, lat: 60.1699, lon: -24.9384, lastMod: 1_700_000_500 })
    expect(c.publicKey).toEqual(PK)
    expect(c.outPath).toHaveLength(64)
    expect(decodePath(c.outPathLen, c.outPath)).toEqual(['1122', '3344'])
  })

  it('decodes a CONTACT without the optional tail', () => {
    expect(decodeContact(contact(false))).toMatchObject({ lat: 0, lon: 0, lastMod: 0 })
  })

  it('throws on a truncated CONTACT', () => {
    expect(() => decodeContact(contact().subarray(0, 60))).toThrow(RangeError)
  })

  it('decodes CHANNEL_INFO', () => {
    const secret = Uint8Array.from({ length: 16 }, (_, i) => i)
    const c = decodeChannelInfo(new LeWriter().u8(Resp.CHANNEL_INFO).u8(3).bytes(padded('#test', 32)).bytes(secret).finish())
    expect(c).toEqual({ index: 3, name: '#test', secret })
  })

  const prefix = Uint8Array.of(1, 2, 3, 4, 5, 6)

  it('decodes CONTACT_MSG_RECV_V3', () => {
    const f = new LeWriter().u8(Resp.CONTACT_MSG_RECV_V3).u8(-22).u16(0).bytes(prefix).u8(0xff).u8(TxtType.PLAIN).u32(1_700_000_000).bytes(utf8Encode('hej då')).finish()
    expect(decodeContactMsg(f)).toEqual({ senderPrefix: prefix, snr: -5.5, pathLen: 0xff, txtType: 0, senderTs: 1_700_000_000, author: undefined, text: 'hej då' })
  })

  it('decodes a SIGNED_PLAIN room post with author prefix', () => {
    const f = new LeWriter().u8(Resp.CONTACT_MSG_RECV_V3).u8(12).u16(0).bytes(prefix).u8(2).u8(TxtType.SIGNED_PLAIN).u32(5).bytes([0xde, 0xad, 0xbe, 0xef]).bytes(utf8Encode('post')).finish()
    expect(decodeContactMsg(f)).toMatchObject({ snr: 3, txtType: 2, author: 'deadbeef', text: 'post' })
  })

  it('decodes legacy CONTACT_MSG_RECV without SNR', () => {
    const f = new LeWriter().u8(Resp.CONTACT_MSG_RECV).bytes(prefix).u8(1).u8(0).u32(9).bytes(utf8Encode('x')).finish()
    expect(decodeContactMsg(f)).toMatchObject({ snr: undefined, pathLen: 1, senderTs: 9, text: 'x' })
  })

  it('decodes CHANNEL_MSG_RECV_V3 and legacy', () => {
    const v3 = new LeWriter().u8(Resp.CHANNEL_MSG_RECV_V3).u8(-4).u16(0).u8(1).u8(3).u8(0).u32(77).bytes(utf8Encode('Bob: hi')).finish()
    expect(decodeChannelMsg(v3)).toEqual({ channel: 1, snr: -1, pathLen: 3, txtType: 0, senderTs: 77, text: 'Bob: hi' })
    const legacy = new LeWriter().u8(Resp.CHANNEL_MSG_RECV).u8(0).u8(0).u8(0).u32(1).bytes(utf8Encode('a: b')).finish()
    expect(decodeChannelMsg(legacy)).toMatchObject({ channel: 0, snr: undefined, text: 'a: b' })
  })

  it('decodes SENT', () => {
    expect(decodeSent(new LeWriter().u8(Resp.SENT).u8(1).u32(0xdeadbeef).u32(12_000).finish())).toEqual({ flood: true, tag: 0xdeadbeef, timeoutMs: 12_000 })
    expect(decodeSent(new LeWriter().u8(Resp.SENT).u8(0).u32(1).u32(2).finish()).flood).toBe(false)
  })

  it('decodes PATH_DISCOVERY_RESPONSE with sized paths', () => {
    const f = new LeWriter().u8(0x8d).u8(0).bytes(prefix).u8(0x42).bytes([0xaa, 0xbb, 0xcc, 0xdd]).u8(0x01).bytes([0x99]).finish()
    expect(decodePathDiscovery(f)).toEqual({
      prefix,
      out: ['aabb', 'ccdd'],
      in: ['99'],
      outLen: 0x42,
      outBytes: Uint8Array.of(0xaa, 0xbb, 0xcc, 0xdd),
    })
    const flood = new LeWriter().u8(0x8d).u8(0).bytes(prefix).u8(OUT_PATH_FLOOD).u8(0).finish()
    expect(decodePathDiscovery(flood)).toEqual({ prefix, out: undefined, in: [], outLen: OUT_PATH_FLOOD, outBytes: new Uint8Array() })
  })

  it('decodes LOG_RX_DATA header bits', () => {
    const r = decodeRxLog(Uint8Array.of(0x88, -40 & 0xff, -90 & 0xff, (5 << 2) | 1, 0x00))
    expect(r).toMatchObject({ snr: -10, rssi: -90, routeType: 1, payloadType: 5 })
  })

  it('names codes', () => {
    expect(codeName(Resp.CONTACT)).toBe('RESP_CONTACT')
    expect(codeName(0x85)).toBe('PUSH_LOGIN_SUCCESS')
    expect(codeName(0x7f)).toBe('0x7f')
  })
})

describe('paths', () => {
  it('decodePath unpacks hash size from the top bits', () => {
    const b = Uint8Array.from({ length: 12 }, (_, i) => i)
    expect(decodePath(0x03, b)).toEqual(['00', '01', '02'])
    expect(decodePath(0x42, b)).toEqual(['0001', '0203'])
    expect(decodePath(0x83, b)).toEqual(['000102', '030405', '060708'])
    expect(decodePath(0, b)).toEqual([])
    expect(decodePath(OUT_PATH_FLOOD, b)).toBeUndefined()
  })

  it('pathHops ignores the hash-size bits', () => {
    expect(pathHops(0x03)).toBe(3)
    expect(pathHops(0x42)).toBe(2)
    expect(pathHops(0xbf)).toBe(63)
    expect(pathHops(0)).toBe(0)
    expect(pathHops(OUT_PATH_FLOOD)).toBeUndefined()
  })
})

describe('groupTextCiphertext', () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => i * 7)

  const reference = (ts: number, body: string) => {
    const b = utf8Encode(body)
    const plain = Buffer.alloc(Math.ceil((5 + b.length) / 16) * 16)
    plain.writeUInt32LE(ts, 0)
    plain.set(b, 5)
    const c = createCipheriv('aes-128-ecb', secret.subarray(0, 16), null)
    c.setAutoPadding(false)
    return new Uint8Array(Buffer.concat([c.update(plain), c.final()]))
  }

  it('matches AES-128-ECB over [ts][0]["name: text"] zero-padded', async () => {
    for (const text of ['', 'hi', 'exactly eleven', 'a much longer message that spans several AES blocks ✓']) {
      const ct = await groupTextCiphertext(secret, 1_700_000_000, 'Me', text)
      expect(ct.length % 16).toBe(0)
      expect(ct.length).toBe(Math.ceil((5 + utf8Encode(`Me: ${text}`).length) / 16) * 16)
      expect(ct).toEqual(reference(1_700_000_000, `Me: ${text}`))
    }
  })

  it('is deterministic and block-wise (ECB)', async () => {
    const a = await groupTextCiphertext(secret, 42, 'Alice', 'same first block, different tail AAAA')
    const b = await groupTextCiphertext(secret, 42, 'Alice', 'same first block, different tail BBBB')
    expect(await groupTextCiphertext(secret, 42, 'Alice', 'same first block, different tail AAAA')).toEqual(a)
    expect(a.subarray(0, 16)).toEqual(b.subarray(0, 16))
    expect(a).not.toEqual(b)
    const c = await groupTextCiphertext(secret, 43, 'Alice', 'same first block, different tail AAAA')
    expect(c.subarray(0, 16)).not.toEqual(a.subarray(0, 16))
    expect(c.subarray(16)).toEqual(a.subarray(16))
  })
})

describe('commands', () => {
  it('builds handshake commands', () => {
    expect([...cmdDeviceQuery()]).toEqual([Cmd.DEVICE_QUERY, 3])
    const a = cmdAppStart('mm')
    expect([...a]).toEqual([Cmd.APP_START, 0, 0, 0, 0, 0, 0, 0, 0x6d, 0x6d])
    expect([...cmdSetTime(0x01020304)]).toEqual([Cmd.SET_DEVICE_TIME, 4, 3, 2, 1])
  })

  it('builds text commands', () => {
    const t = cmdSendText(PK, 'yo', 0x11223344, 1)
    expect([...t.subarray(0, 7)]).toEqual([Cmd.SEND_TXT_MSG, TxtType.PLAIN, 1, 0x44, 0x33, 0x22, 0x11])
    expect(t.subarray(7, 13)).toEqual(PK.subarray(0, 6))
    expect(new TextDecoder().decode(t.subarray(13))).toBe('yo')
    const c = cmdSendChannelText(2, 'ch', 1)
    expect([...c]).toEqual([Cmd.SEND_CHANNEL_TXT_MSG, 0, 2, 1, 0, 0, 0, 0x63, 0x68])
    const p = cmdPathDiscovery(PK)
    expect(p.length).toBe(34)
    expect([p[0], p[1]]).toEqual([Cmd.SEND_PATH_DISCOVERY_REQ, 0])
  })
})

describe('hashtag channels', () => {
  it('derive the key from the name, # included', async () => {
    expect(hex(await hashtagSecret('#test'))).toBe('9cd8fcf22a47333b591d96a2b848b73f')
  })
  it('are recognised by key, not by name alone', async () => {
    const key = await hashtagSecret('#test')
    expect(await isHashtagChannel('#test', key)).toBe(true)
    expect(await isHashtagChannel('#Test', key)).toBe(false)
    expect(await isHashtagChannel('#test', new Uint8Array(16))).toBe(false)
    expect(await isHashtagChannel('test', await hashtagSecret('test'))).toBe(false)
  })
})
