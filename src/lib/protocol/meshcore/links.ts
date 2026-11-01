// meshcore:// contact links. Two forms are in use:
//  - contact card (docs.meshcore.io/qr_codes): meshcore://contact/add?name=..&public_key=<64 hex>&type=N
//  - advert ("biz card"): meshcore://<hex of a signed advert packet>, from CMD_EXPORT_CONTACT;
//    the apps' "share contact" / clipboard export, T-Deck "Card to Clipboard".
import { hex, LeReader, utf8Decode } from '../bytes'

export interface ContactLink {
  name: string
  /** 64 lowercase hex. */
  publicKey: string
  /** 1 chat, 2 repeater, 3 room, 4 sensor. */
  type: number
  /** Advert form only: the raw packet, as sent to CMD_IMPORT_CONTACT. */
  advert?: Uint8Array
  /** Advert form only: the advert's timestamp (sender clock, seconds). */
  advertTs?: number
  lat?: number
  lon?: number
}

export function contactLink(c: ContactLink): string {
  const q = new URLSearchParams({ name: c.name, public_key: c.publicKey.toLowerCase(), type: String(c.type) })
  return `meshcore://contact/add?${q}`
}

export const advertLink = (packet: Uint8Array) => `meshcore://${hex(packet)}`

/** Parses either link form; null if neither. */
export function parseContactLink(text: string): ContactLink | null {
  const t = text.trim()
  const card = t.match(/^meshcore:\/\/contact\/add\/?\?(.*)$/i)
  if (card) return parseCard(card[1])
  const adv = t.match(/^meshcore:\/\/([0-9a-f]+)\/?$/i)
  return adv ? decodeAdvertPacket(fromHex(adv[1])) : null
}

function parseCard(query: string): ContactLink | null {
  const q = new URLSearchParams(query)
  const publicKey = (q.get('public_key') ?? '').toLowerCase()
  const type = Number(q.get('type') ?? '1')
  if (!/^[0-9a-f]{64}$/.test(publicKey) || !(type >= 1 && type <= 4)) return null
  return { name: (q.get('name') ?? '').slice(0, 31), publicKey, type }
}

function fromHex(h: string): Uint8Array | null {
  if (h.length % 2) return null
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16))
}

const PAYLOAD_ADVERT = 4
const MAX_PATH = 64
const MAX_APP_DATA = 32
const SIG = 64
/** CMD_IMPORT_CONTACT frame is at most 172 bytes including the command byte. */
const MAX_PACKET = 171
const ADV_LATLON = 0x10
const ADV_FEAT1 = 0x20
const ADV_FEAT2 = 0x40
const ADV_NAME = 0x80

/**
 * Decodes a raw advert packet the way the firmware reads it (Packet::readFrom, Mesh advert
 * handling, AdvertDataParser). The signature is not checked here; see verifyAdvert.
 */
export function decodeAdvertPacket(p: Uint8Array | null): ContactLink | null {
  if (!p || p.length < 2 || p.length > MAX_PACKET) return null
  const header = p[0]
  if (((header >> 2) & 0x0f) !== PAYLOAD_ADVERT) return null
  const route = header & 3
  let i = 1 + (route === 0 || route === 3 ? 4 : 0) // transport codes
  const pathLen = p[i++]
  const hashSize = (pathLen >> 6) + 1
  if (hashSize === 4 || (pathLen & 63) * hashSize > MAX_PATH) return null
  i += (pathLen & 63) * hashSize
  const payload = p.subarray(i)
  if (payload.length < 32 + 4 + SIG + 1) return null
  const r = new LeReader(payload)
  const publicKey = hex(r.bytes(32))
  const advertTs = r.u32()
  r.bytes(SIG)
  const app = payload.subarray(32 + 4 + SIG, 32 + 4 + SIG + MAX_APP_DATA)
  const flags = app[0]
  const type = flags & 0x0f
  if (type < 1 || type > 4 || !(flags & ADV_NAME)) return null // the firmware drops nameless adverts
  let j = 1
  let lat: number | undefined
  let lon: number | undefined
  if (flags & ADV_LATLON) {
    if (app.length < j + 8) return null
    const ar = new LeReader(app.subarray(j, j + 8))
    lat = ar.i32() / 1e6
    lon = ar.i32() / 1e6
    j += 8
  }
  if (flags & ADV_FEAT1) j += 2
  if (flags & ADV_FEAT2) j += 2
  if (app.length <= j) return null
  const name = utf8Decode(app.subarray(j)).replace(/\0.*$/s, '').slice(0, 31)
  const out: ContactLink = { name, publicKey, type, advert: p.slice(), advertTs }
  if (lat !== undefined && (lat || lon)) Object.assign(out, { lat, lon })
  return out
}

/**
 * Checks the advert's Ed25519 signature over public key, timestamp and app data (as the
 * firmware does). Resolves undefined where the browser has no Ed25519.
 */
export async function verifyAdvert(l: ContactLink): Promise<boolean | undefined> {
  if (!l.advert) return undefined
  const p = l.advert
  const route = p[0] & 3
  let i = 1 + (route === 0 || route === 3 ? 4 : 0)
  const pathLen = p[i++]
  i += (pathLen & 63) * ((pathLen >> 6) + 1)
  const payload = p.subarray(i)
  const pk = payload.slice(0, 32)
  const sig = payload.slice(36, 36 + SIG)
  const app = payload.subarray(36 + SIG, 36 + SIG + MAX_APP_DATA)
  const msg = new Uint8Array(36 + app.length)
  msg.set(payload.subarray(0, 36))
  msg.set(app, 36)
  try {
    const key = await crypto.subtle.importKey('raw', pk, { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, msg)
  } catch {
    return undefined
  }
}
