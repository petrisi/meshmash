// MeshCore channel texts heard over the air: verified decryption and the claimed sender name,
// treated as untrusted input.
import { describe, expect, it } from 'vitest'
import type { PacketRecord } from '../src/lib/model/analytics'
import { utf8Encode } from '../src/lib/protocol/bytes'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { type Contact, decryptGroupText, Push, splitSenderName } from '../src/lib/protocol/meshcore/codec'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

const SECRET = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i)
const OTHER_SECRET = Uint8Array.from({ length: 16 }, (_, i) => 0x90 + i)

/** A GRP_TXT payload as the firmware builds it: [hash][MAC 2][AES-128-ECB of [ts][flags][text]]. */
async function groupPayload(secret: Uint8Array, text: Uint8Array | string, txtType = 0, opts: { badMac?: boolean; hash?: number } = {}) {
  const body = typeof text === 'string' ? utf8Encode(text) : text
  const plain = new Uint8Array(Math.ceil((5 + body.length) / 16) * 16)
  new DataView(plain.buffer).setUint32(0, 1_700_000_000, true)
  plain[4] = txtType << 2
  plain.set(body, 5)
  const key = await crypto.subtle.importKey('raw', new Uint8Array(secret), 'AES-CBC', false, ['encrypt'])
  const ct = new Uint8Array(plain.length)
  for (let i = 0; i < plain.length; i += 16) {
    ct.set(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, plain.slice(i, i + 16)), 0, 16), i)
  }
  const macKey = new Uint8Array(32)
  macKey.set(secret)
  const hk = await crypto.subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hk, ct))
  const hash = opts.hash ?? new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(secret)))[0]
  return Uint8Array.of(hash, mac[0] ^ (opts.badMac ? 1 : 0), mac[1], ...ct)
}

describe('splitSenderName', () => {
  it('reads the firmware format', () => {
    expect(splitSenderName('Hill: hello')).toEqual({ name: 'Hill', text: 'hello' })
    expect(splitSenderName('A: b: c')).toEqual({ name: 'A', text: 'b: c' })
  })
  it('gives no name when the text does not follow the format', () => {
    for (const t of ['no separator', ': leading', 'a:b', 'Hill :x', ''] ) expect(splitSenderName(t)).toEqual({ text: t })
  })
  it('a name longer than the firmware allows (31 bytes) is not a name', () => {
    expect(splitSenderName(`${'x'.repeat(31)}: t`).name).toBe('x'.repeat(31))
    expect(splitSenderName(`${'x'.repeat(32)}: t`).name).toBeUndefined()
    expect(splitSenderName(`${'😀'.repeat(8)}: t`).name).toBeUndefined() // 32 bytes
  })
  it('strips control and bidi characters; nothing left means no name', () => {
    expect(splitSenderName('Ev‮il\u0007: t').name).toBe('Evil')
    expect(splitSenderName('‏\u0001 : t')).toEqual({ text: '‏\u0001 : t' })
  })
})

describe('decryptGroupText', () => {
  it('opens a channel text with the right key', async () => {
    expect(await decryptGroupText(SECRET, await groupPayload(SECRET, 'Hill: hi'))).toEqual({ ts: 1_700_000_000, txtType: 0, text: 'Hill: hi' })
  })
  it('rejects another key, a bad MAC, a wrong channel hash, a cut payload', async () => {
    const p = await groupPayload(SECRET, 'Hill: hi')
    expect(await decryptGroupText(OTHER_SECRET, p)).toBeNull()
    expect(await decryptGroupText(SECRET, await groupPayload(SECRET, 'Hill: hi', 0, { badMac: true }))).toBeNull()
    expect(await decryptGroupText(SECRET, await groupPayload(SECRET, 'Hill: hi', 0, { hash: p[0] ^ 1 }))).toBeNull()
    expect(await decryptGroupText(SECRET, p.subarray(0, p.length - 1))).toBeNull()
    expect(await decryptGroupText(SECRET, p.subarray(0, 3))).toBeNull()
  })
  it('rejects text that is not valid UTF-8', async () => {
    expect(await decryptGroupText(SECRET, await groupPayload(SECRET, Uint8Array.of(0x48, 0xff, 0xfe, 0x3a, 0x20, 0x61)))).toBeNull()
  })
})

// Through the client: LOG_RX_DATA frames.

const contact = (pk: number, name: string): Contact => ({
  publicKey: Uint8Array.from({ length: 32 }, (_, i) => pk + i),
  type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name, lastAdvert: 0, lat: 0, lon: 0, lastMod: 0,
})
const hex6 = (c: Contact) => [...c.publicKey.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')

function setup(contacts: Contact[]) {
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async () => {} }
  const rec = recordingSink()
  const records: PacketRecord[] = []
  rec.sink.packet = (r) => void records.push(r)
  const client = new MeshCoreClient(t as unknown as Transport, rec.sink)
  const inner = client as unknown as { secrets: Map<number, Uint8Array>; contacts: Map<string, Contact>; self: { publicKey: Uint8Array } }
  inner.self = { publicKey: new Uint8Array(32) }
  inner.secrets.set(3, SECRET)
  for (const c of contacts) inner.contacts.set(hex6(c), c)
  const hear = (payload: Uint8Array, path: number[] = []) =>
    t.onData(mcIn(Uint8Array.of(Push.LOG_RX_DATA, 20, 0xa6, (5 << 2) | 1, path.length, ...path, ...payload)))
  const settle = () => new Promise((r) => setTimeout(r, 50))
  return { records, hear, settle }
}

describe('MeshCore channel texts in Analytics', () => {
  it('credits a unique contact name; repeats reuse the result', async () => {
    const hill = contact(0x10, 'Hill')
    const { records, hear, settle } = setup([hill, contact(0x40, 'Vale')])
    const p = await groupPayload(SECRET, 'Hill: hello')
    hear(p, [0xaa])
    hear(p, [0xaa, 0xbb])
    await settle()
    expect(records.map((r) => [r.type, r.channel, r.name, r.from, r.dup])).toEqual([
      ['channel', 3, 'Hill', hex6(hill), undefined],
      ['channel', 3, 'Hill', hex6(hill), true],
    ])
  })

  it('a name shared by two contacts, or by none, stays a name only', async () => {
    const { records, hear, settle } = setup([contact(0x10, 'Twin'), contact(0x40, 'Twin')])
    hear(await groupPayload(SECRET, 'Twin: a'))
    hear(await groupPayload(SECRET, 'Stranger: b'))
    await settle()
    expect(records.map((r) => [r.name, r.from]).sort()).toEqual([
      ['Stranger', undefined],
      ['Twin', undefined],
    ])
  })

  it('hostile text: no name unless it fits the format, cleaned when it does', async () => {
    const { records, hear, settle } = setup([])
    hear(await groupPayload(SECRET, 'no separator here'))
    hear(await groupPayload(SECRET, `${'x'.repeat(40)}: long`))
    hear(await groupPayload(SECRET, 'Ev‮il: x'))
    await settle()
    // Records come as each decryption finishes; order does not matter.
    expect(records.map((r) => r.name ?? '-').sort()).toEqual(['-', '-', 'Evil'])
  })

  it('channels we do not have, and other text types, give no name', async () => {
    const { records, hear, settle } = setup([])
    hear(await groupPayload(OTHER_SECRET, 'Hill: hi'))
    hear(await groupPayload(SECRET, 'Hill: signed', 2))
    await settle()
    expect(records.map((r) => r.channel ?? -1).sort()).toEqual([-1, 3])
    expect(records.every((r) => r.name === undefined)).toBe(true)
  })
})
