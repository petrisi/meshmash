// meshcore:// contact links: the contact card (contact/add?...) and the advert form
// (meshcore://<signed advert packet hex>), and how the client imports and exports them.
import { describe, expect, it } from 'vitest'
import { hex, LeWriter, utf8Encode } from '../src/lib/protocol/bytes'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Cmd, cmdUpdateContact, type Contact, Push, Resp } from '../src/lib/protocol/meshcore/codec'
import { advertLink, contactLink, decodeAdvertPacket, parseContactLink, verifyAdvert } from '../src/lib/protocol/meshcore/links'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

interface AdvertOpts {
  type?: number
  name?: string
  ts?: number
  latLon?: [number, number]
  /** Packet header; default 0x11 (flood, ADVERT), as CMD_EXPORT_CONTACT gives. */
  header?: number
  transport?: boolean
  path?: number[]
  pathLen?: number
}

/** A signed advert packet, laid out as the firmware writes it (Mesh::createAdvert, Packet::writeTo). */
async function makeAdvert(o: AdvertOpts = {}) {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const pk = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))
  const app = new LeWriter().u8((o.type ?? 1) | 0x80 | (o.latLon ? 0x10 : 0))
  if (o.latLon) app.i32(Math.round(o.latLon[0] * 1e6)).i32(Math.round(o.latLon[1] * 1e6))
  const appData = new Uint8Array([...app.finish(), ...utf8Encode(o.name ?? 'Test node')])
  const ts = o.ts ?? 1_700_000_000
  const signed = new LeWriter().bytes(pk).u32(ts).bytes(appData).finish()
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, signed))
  const path = o.path ?? []
  const w = new LeWriter().u8(o.header ?? 0x11)
  if (o.transport) w.u16(0x1234).u16(0)
  w.u8(o.pathLen ?? path.length).bytes(Uint8Array.from(path))
  const packet = w.bytes(pk).u32(ts).bytes(sig).bytes(appData).finish()
  return { packet, pk, ts, link: advertLink(packet) }
}

const KEY = 'ab'.repeat(32)
/** The radio clock when it stamps an imported contact. */
const NOW = Math.floor(Date.now() / 1000)
const id6 = (pk: Uint8Array) => hex(pk.subarray(0, 6))

describe('contact card links', () => {
  it('parses name, key and type', () => {
    const l = parseContactLink(`meshcore://contact/add?name=Example+Contact&public_key=${KEY.toUpperCase()}&type=2`)
    expect(l).toEqual({ name: 'Example Contact', publicKey: KEY, type: 2 })
    expect(parseContactLink(`  MESHCORE://contact/add/?public_key=${KEY}  `)).toEqual({ name: '', publicKey: KEY, type: 1 })
  })
  it('round-trips through contactLink, names cut to 31 bytes worth of characters', () => {
    const name = 'x'.repeat(40)
    expect(parseContactLink(contactLink({ name, publicKey: KEY, type: 3 }))).toEqual({ name: name.slice(0, 31), publicKey: KEY, type: 3 })
  })
  it('rejects short keys, bad types and other links', () => {
    expect(parseContactLink(`meshcore://contact/add?public_key=${KEY.slice(0, 12)}`)).toBeNull()
    expect(parseContactLink(`meshcore://contact/add?public_key=${KEY}&type=5`)).toBeNull()
    expect(parseContactLink(`meshcore://contact/add?public_key=${KEY}&type=nope`)).toBeNull()
    expect(parseContactLink('meshcore://channel/add?name=Public&secret=8b3387e9c5cdea6ac9e5edbaa115cd72')).toBeNull()
    expect(parseContactLink('hello')).toBeNull()
  })
})

describe('advert links', () => {
  it('decodes key, name, type, timestamp and location; signature verifies', async () => {
    const a = await makeAdvert({ type: 2, name: 'Hill repeater', ts: 1_720_000_000, latLon: [10.5, -20.25] })
    const l = parseContactLink(a.link)!
    expect(l).toMatchObject({ name: 'Hill repeater', publicKey: hex(a.pk), type: 2, advertTs: 1_720_000_000, lat: 10.5, lon: -20.25 })
    expect([...l.advert!]).toEqual([...a.packet])
    expect(await verifyAdvert(l)).toBe(true)
    expect(parseContactLink(a.link.toUpperCase().replace('MESHCORE', 'meshcore'))?.publicKey).toBe(hex(a.pk))
  })
  it('a changed byte fails the signature check', async () => {
    const a = await makeAdvert({ name: 'Alice' })
    const bad = a.packet.slice()
    bad[bad.length - 1] ^= 1 // name 'Alicd'
    const l = decodeAdvertPacket(bad)!
    expect(l.name).toBe('Alicd')
    expect(await verifyAdvert(l)).toBe(false)
  })
  it('reads past transport codes and a path', async () => {
    const t = await makeAdvert({ header: 0x10, transport: true, name: 'T' })
    expect(parseContactLink(t.link)).toMatchObject({ name: 'T', publicKey: hex(t.pk) })
    expect(await verifyAdvert(parseContactLink(t.link)!)).toBe(true)
    const p = await makeAdvert({ path: [0xaa, 0xbb, 0xcc, 0xdd], pathLen: 0x42, name: 'P' }) // two 2-byte hashes
    expect(parseContactLink(p.link)).toMatchObject({ name: 'P', publicKey: hex(p.pk) })
    expect(await verifyAdvert(parseContactLink(p.link)!)).toBe(true)
  })
  it('no location when the advert has none or it is 0,0', async () => {
    expect(parseContactLink((await makeAdvert()).link)?.lat).toBeUndefined()
    expect(parseContactLink((await makeAdvert({ latLon: [0, 0] })).link)?.lat).toBeUndefined()
  })
  it('rejects what the firmware would not take', async () => {
    const a = await makeAdvert()
    const h = hex(a.packet)
    expect(parseContactLink(`meshcore://${h.slice(1)}`)).toBeNull() // odd length
    expect(parseContactLink(`meshcore://${h.slice(0, 100)}`)).toBeNull() // truncated
    expect(parseContactLink(`meshcore://${h}${'00'.repeat(80)}`)).toBeNull() // over the 171-byte frame
    expect(parseContactLink(`meshcore://15${h.slice(2)}`)).toBeNull() // payload type 5, not an advert
    expect(parseContactLink(`meshcore://11c1${h.slice(4)}`)).toBeNull() // path hash size 4 is reserved
    expect(parseContactLink((await makeAdvert({ type: 0 })).link)).toBeNull()
    const nameless = a.packet.slice(0, 2 + 32 + 4 + 64 + 1)
    nameless[nameless.length - 1] = 0x01
    expect(decodeAdvertPacket(nameless)).toBeNull()
  })
})

/** A companion radio that answers import, export, contact and update commands. */
function fakeRadio(opts: { autoAdd: boolean; stored?: Contact[]; exportAdvert?: Uint8Array; holdBack?: string; adverts?: Record<string, Uint8Array> }) {
  let held: Uint8Array | null = null
  const sent: Uint8Array[] = []
  const radio = new Map<string, Contact>()
  const adverts = new Map<string, Uint8Array>()
  for (const c of opts.stored ?? []) radio.set(hex(c.publicKey), c)
  for (const [k, a] of Object.entries(opts.adverts ?? {})) adverts.set(k, a)
  const contactFrame = (c: Contact) => {
    const f = cmdUpdateContact(c)
    f[0] = Resp.CONTACT
    return f
  }
  const t = {
    label: 'x',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    write: async (b: Uint8Array) => {
      const f = b.subarray(3)
      sent.push(f.slice())
      const flush = held
      held = null
      const reply = (...frames: Uint8Array[]) =>
        setTimeout(() => (flush ? [flush, ...frames] : frames).forEach((x) => t.onData(mcIn(x))))
      switch (f[0]) {
        case Cmd.GET_DEVICE_TIME:
          return reply(new LeWriter().u8(Resp.CURR_TIME).u32(1_800_000_000).finish())
        case Cmd.IMPORT_CONTACT: {
          const l = decodeAdvertPacket(f.subarray(1))!
          const pk = Uint8Array.from(l.publicKey.match(/../g)!, (x) => parseInt(x, 16))
          const known = radio.get(l.publicKey)
          if (known && known.lastAdvert >= l.advertTs!) return reply(Uint8Array.of(Resp.OK))
          const c: Contact = {
            publicKey: pk, type: l.type, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(64),
            name: l.name, lastAdvert: l.advertTs!, lat: l.lat ?? 0, lon: l.lon ?? 0, lastMod: NOW,
          }
          if (!known && !opts.autoAdd) {
            const push = contactFrame(c)
            push[0] = Push.NEW_ADVERT
            return reply(Uint8Array.of(Resp.OK), push)
          }
          radio.set(l.publicKey, c)
          adverts.set(l.publicKey, f.slice(1))
          return reply(Uint8Array.of(Resp.OK), new LeWriter().u8(Push.ADVERT).bytes(pk).finish())
        }
        case Cmd.ADD_UPDATE_CONTACT: {
          const pk = f.subarray(1, 33)
          const dv = new DataView(f.buffer, f.byteOffset)
          const at = 1 + 32 + 3 + 64 + 32
          radio.set(hex(pk), { ...radio.get(hex(pk))!, publicKey: pk.slice(), lastAdvert: dv.getUint32(at, true), lastMod: dv.getUint32(at + 12, true) })
          return reply(Uint8Array.of(Resp.OK))
        }
        case Cmd.GET_CONTACT_BY_KEY: {
          const c = radio.get(hex(f.subarray(1, 33)))
          return reply(c ? contactFrame(c) : Uint8Array.of(Resp.ERR, 2))
        }
        case Cmd.EXPORT_CONTACT: {
          const key = f.length > 1 ? hex(f.subarray(1, 33)) : ''
          const p = key ? adverts.get(key) : opts.exportAdvert
          // USB quirk: this reply stays in the radio until it sends something else.
          if (p && key === opts.holdBack) return void ((held = Uint8Array.of(Resp.EXPORT_CONTACT, ...p)), reply())
          return reply(p ? Uint8Array.of(Resp.EXPORT_CONTACT, ...p) : Uint8Array.of(Resp.ERR, 2))
        }
      }
    },
  }
  const rec = recordingSink()
  const client = new MeshCoreClient(t as unknown as Transport, rec.sink)
  const internals = client as unknown as { contacts: Map<string, Contact>; self: { publicKey: Uint8Array } }
  internals.self = { publicKey: new Uint8Array(32).fill(0xee) } as never
  for (const c of opts.stored ?? []) internals.contacts.set(id6(c.publicKey), c)
  return { client, sent, radio, rec, contacts: internals.contacts, cmds: () => sent.map((x) => x[0]) }
}

describe('MeshCore import', () => {
  it('advert link: sends the packet with CMD_IMPORT_CONTACT; an auto-added contact is read back', async () => {
    const a = await makeAdvert({ name: 'Bob', latLon: [1.5, 2.5] })
    const r = fakeRadio({ autoAdd: true })
    const id = await r.client.importContact(a.link)
    expect(id).toBe(id6(a.pk))
    expect(r.cmds()).toEqual([Cmd.IMPORT_CONTACT, Cmd.GET_CONTACT_BY_KEY, Cmd.ADD_UPDATE_CONTACT])
    expect([...r.sent[0].subarray(1)]).toEqual([...a.packet])
    // Last heard is the advert's time, not the import's.
    expect(r.rec.nodes.get(id)).toMatchObject({ longName: 'Bob', position: { lat: 1.5, lon: 2.5 }, lastHeard: a.ts * 1000 })
    expect(r.radio.get(hex(a.pk))?.lastMod).toBe(a.ts)
    expect(r.contacts.has(id)).toBe(true)
  })

  it('advert link in manual-add mode: saved, then imported again so the radio keeps the advert', async () => {
    const a = await makeAdvert({ name: 'Carol', ts: 1_710_000_000 })
    const r = fakeRadio({ autoAdd: false })
    const id = await r.client.importContact(a.link)
    expect(r.cmds()).toEqual([Cmd.IMPORT_CONTACT, Cmd.ADD_UPDATE_CONTACT, Cmd.IMPORT_CONTACT, Cmd.GET_CONTACT_BY_KEY, Cmd.ADD_UPDATE_CONTACT])
    expect(r.radio.get(hex(a.pk))?.lastAdvert).toBe(1_710_000_000)
    expect(r.rec.nodes.get(id)).toMatchObject({ longName: 'Carol', unsaved: false })
    // Now the radio has the advert to share.
    expect(await r.client.exportContact(id)).toBe(a.link)
  })

  it('a known contact with the same or a newer advert: nothing sent', async () => {
    const a = await makeAdvert({ ts: 1_700_000_000 })
    const c = { publicKey: a.pk, type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'x', lastAdvert: 1_700_000_000, lat: 0, lon: 0, lastMod: 0 }
    const r = fakeRadio({ autoAdd: true, stored: [c] })
    expect(await r.client.importContact(a.link)).toBe(id6(a.pk))
    expect(r.sent).toEqual([])
  })

  it('a known contact with an older advert (e.g. added from a card) is updated', async () => {
    const a = await makeAdvert({ ts: 1_700_000_000, name: 'New name' })
    const c = { publicKey: a.pk, type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'old', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 }
    const r = fakeRadio({ autoAdd: false, stored: [c] })
    await r.client.importContact(a.link)
    expect(r.cmds()[0]).toBe(Cmd.IMPORT_CONTACT)
    expect(r.rec.nodes.get(id6(a.pk))?.longName).toBe('New name')
  })

  it('bad signature: rejected before anything is sent', async () => {
    const a = await makeAdvert({ name: 'Alice' })
    const bad = a.packet.slice()
    bad[bad.length - 1] ^= 1
    const r = fakeRadio({ autoAdd: true })
    await expect(r.client.importContact(advertLink(bad))).rejects.toThrow(/signature/)
    expect(r.sent).toEqual([])
  })

  it('no push from the radio: reported as not accepted', { timeout: 10_000 }, async () => {
    const a = await makeAdvert()
    const r = fakeRadio({ autoAdd: true })
    // The radio answers OK but never pushes the contact (as when it drops the advert).
    const c = { publicKey: a.pk, type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'x', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 }
    r.radio.set(hex(a.pk), { ...c, lastAdvert: 2_000_000_000 })
    await expect(r.client.importContact(a.link)).rejects.toThrow(/did not accept/)
    expect(r.cmds()).toEqual([Cmd.IMPORT_CONTACT])
  })

  it('this radio\'s own advert is refused', async () => {
    const r = fakeRadio({ autoAdd: true })
    const self = (r.client as unknown as { self: { publicKey: Uint8Array } }).self
    self.publicKey = (await makeAdvert()).pk
    const own = await makeAdvert()
    self.publicKey = own.pk
    await expect(r.client.importContact(own.link)).rejects.toThrow(/this radio/)
  })

  it('contact card link: still saved with CMD_ADD_UPDATE_CONTACT', async () => {
    const r = fakeRadio({ autoAdd: true })
    r.radio.set(KEY, { publicKey: new Uint8Array(32), type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: '', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 })
    const id = await r.client.importContact(contactLink({ name: 'Dave', publicKey: KEY, type: 3 }))
    expect(id).toBe(KEY.slice(0, 12))
    expect(r.cmds()).toEqual([Cmd.ADD_UPDATE_CONTACT])
    expect(r.rec.nodes.get(id)).toMatchObject({ longName: 'Dave', kind: 'room' })
  })
})

describe('MeshCore export', () => {
  it('own advert: CMD_EXPORT_CONTACT without a key', async () => {
    const own = await makeAdvert({ name: 'Me' })
    const r = fakeRadio({ autoAdd: true, exportAdvert: own.packet })
    ;(r.client as unknown as { self: { publicKey: Uint8Array } }).self.publicKey = own.pk
    expect(await r.client.exportContact(id6(own.pk))).toBe(own.link)
    expect([...r.sent[0]]).toEqual([Cmd.EXPORT_CONTACT])
  })
  it('a contact without a stored advert, or an unknown node: null (the caller falls back to a card)', async () => {
    const c = { publicKey: Uint8Array.from({ length: 32 }, (_, i) => i), type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'x', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 }
    const r = fakeRadio({ autoAdd: true, stored: [c] })
    expect(await r.client.exportContact('000102030405')).toBeNull()
    expect([...r.sent[0].subarray(0, 3)]).toEqual([Cmd.EXPORT_CONTACT, 0, 1])
    expect(await r.client.exportContact('ffffffffffff')).toBeNull()
    expect(r.sent.length).toBe(1)
  })
})

describe('MeshCore export: a held-back reply', () => {
  it('is fetched with the next command, and not taken as the answer to a later export', { timeout: 10_000 }, async () => {
    const room = await makeAdvert({ type: 3, name: 'Room' })
    const other = await makeAdvert({ name: 'Other' })
    const contact = (pk: Uint8Array): Contact => ({ publicKey: pk, type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'x', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 })
    const r = fakeRadio({
      autoAdd: true,
      stored: [contact(room.pk), contact(other.pk)],
      adverts: { [hex(room.pk)]: room.packet, [hex(other.pk)]: other.packet },
      holdBack: hex(room.pk),
    })
    expect(await r.client.exportContact(id6(room.pk))).toBe(room.link)
    expect(r.cmds()).toEqual([Cmd.EXPORT_CONTACT, Cmd.GET_DEVICE_TIME])
    expect(await r.client.exportContact(id6(other.pk))).toBe(other.link)
  })
  it('a stale reply arriving during another export is skipped', async () => {
    const a = await makeAdvert({ name: 'A' })
    const b = await makeAdvert({ name: 'B' })
    const contact = (pk: Uint8Array): Contact => ({ publicKey: pk, type: 1, flags: 0, outPathLen: 0xff, outPath: new Uint8Array(), name: 'x', lastAdvert: 0, lat: 0, lon: 0, lastMod: 0 })
    const r = fakeRadio({ autoAdd: true, stored: [contact(b.pk)], adverts: { [hex(b.pk)]: b.packet } })
    // As if an earlier export's reply for A were still on its way.
    const internals = r.client as unknown as { onData: (c: Uint8Array) => void }
    const p = r.client.exportContact(id6(b.pk))
    internals.onData(mcIn(Uint8Array.of(Resp.EXPORT_CONTACT, ...a.packet)))
    expect(await p).toBe(b.link)
  })
})

