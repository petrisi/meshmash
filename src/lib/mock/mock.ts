// Demo data for UI development without hardware. All names are fictional.
import type {
  Channel,
  ChannelConfig,
  MeshNode,
  Message,
  NodeKind,
  Protocol,
  RadioInfo,
  Sample,
  ThreadKey,
} from '../model/types'
import { initials } from '../format'
import { relayByte } from '../model/relay'

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

const PLACES = [
  'Hilltop', 'Harbor', 'Pine', 'Granite', 'Lakeside', 'North', 'Ridge', 'Meadow', 'Birch', 'Quarry',
  'Mill', 'Tower', 'Island', 'Bay', 'Valley', 'Forest', 'Cape', 'Marsh', 'Summit', 'Bridge',
]
const THINGS = [
  'Relay', 'Base', 'Rover', 'Node', 'Station', 'Mobile', 'Camp', 'Roof', 'Car', 'Hut', 'Gate', 'Beacon',
]
const EMOJIS = ['📡', '🏔️', '🐻', '⛺', '🚐', '🌲', '🛰️', '🦊', '⚡', '🏠', '👨‍👩‍👧']
const MT_HW = [
  'HELTEC_V3', 'HELTEC_V4', 'T_BEAM', 'RAK4631', 'T_ECHO', 'STATION_G2', 'SEEED_XIAO_S3',
  'TRACKER_T1000_E', 'HELTEC_WIRELESS_PAPER', 'T_DECK',
]
const MC_HW = ['Heltec V3', 'Xiao S3 WIO', 'RAK 4631', 'T1000-E', 'Heltec T114', 'Station G2']
const CHAT = [
  'anyone copy?', 'Good signal from the ridge today', 'testing new antenna, 5.8 dBi',
  'heard you 3 hops out', 'Repeater on the tower is back up', 'battery at 40%, heading home',
  'nice, got a direct path now', 'is the bay relay still offline?', 'morning all',
  'traceroute shows 2 hops via Harbor', 'weather looks good for the hike', 'ack',
  'Who runs the node on Granite hill? Great coverage.', 'moving to channel 2 for the event',
  'snr -12 but still decoding', 'see you at the meetup Saturday',
]

const HOUR = 3_600_000
const HOP_STARTS = [3, 3, 3, 3, 4, 5, 7]
const REACTIONS = ['👍', '👍', '❤️', '😂', '🙏']
/** The MeshCore Public channel's well-known secret. */
const MC_PUBLIC = '8b3387e9c5cdea6ac9e5edbaa115cd72'

function hex(r: () => number, n: number) {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16)
  return s
}

function bytes(r: () => number, n: number) {
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
}

const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!, (b) => parseInt(b, 16))

function name(r: () => number) {
  return `${PLACES[Math.floor(r() * PLACES.length)]} ${THINGS[Math.floor(r() * THINGS.length)]}`
}

function short(longName: string, len: number) {
  const parts = longName.split(' ')
  return (parts.map((p) => p[0]).join('') + parts[1].slice(1)).slice(0, len).toUpperCase()
}

const HOME = { lat: 61.4978, lon: 23.761 }

export interface MockSession {
  info: RadioInfo
  nodes: MeshNode[]
  channels: Channel[]
  /** Stored names and keys, for the channel editor. MeshCore hashtag keys are filled in by the caller. */
  configs: ChannelConfig[]
  messages: Message[]
  /** Telemetry history for the radio and some nodes. */
  samples: Record<string, Sample[]>
}

export function mockSession(protocol: Protocol): MockSession {
  const r = rng(protocol === 'meshtastic' ? 7 : 11)
  const now = Date.now()
  const isMt = protocol === 'meshtastic'
  const selfId = isMt ? '!a1b2c3d4' : 'f3a91c07e2b4'

  const info: RadioInfo = isMt
    ? {
        protocol,
        firmware: '2.8.0.4f0be0e',
        hwModel: 'HELTEC_V4',
        nodeId: selfId,
        longName: 'Demo Base 01',
        shortName: 'DB01',
        radio: { region: 'EU_868', preset: 'LONG_FAST', freqMHz: 869.525, txPowerDbm: 27 },
        batteryPct: 87,
        voltage: 4.08,
        position: HOME,
      }
    : {
        protocol,
        firmware: 'v1.17.1',
        hwModel: 'Xiao S3 WIO',
        nodeId: selfId,
        longName: 'Demo Base',
        shortName: 'DB',
        radio: { freqMHz: 869.618, bwKHz: 62.5, sf: 8, cr: 8, txPowerDbm: 22 },
        batteryPct: 92,
        voltage: 4.12,
        position: HOME,
      }

  const self: MeshNode = {
    id: selfId,
    longName: info.longName,
    shortName: info.shortName,
    kind: isMt ? 'client' : 'chat',
    hwModel: info.hwModel,
    lastHeard: now,
    hops: 0,
    batteryPct: info.batteryPct,
    voltage: info.voltage,
    channelUtil: 14.2,
    airUtilTx: 2.1,
    uptimeS: 3 * 86400 + 4210,
    position: HOME,
  }

  const mcKinds: NodeKind[] = ['chat', 'chat', 'chat', 'repeater', 'repeater', 'room', 'sensor']
  const mtKinds: NodeKind[] = ['client', 'client', 'client', 'client', 'client_mute', 'router', 'tracker', 'sensor']
  const count = isMt ? 140 : 46
  const used = new Set<string>()
  const nodes: MeshNode[] = [self]
  for (let i = 0; i < count; i++) {
    let ln = name(r)
    while (used.has(ln)) ln = `${name(r)} ${Math.floor(r() * 90 + 10)}`
    used.add(ln)
    // Some names carry emoji, as real ones often do.
    const emoji = r() < 0.15 ? EMOJIS[Math.floor(r() * EMOJIS.length)] : undefined
    if (emoji) ln = r() < 0.5 ? `${emoji} ${ln}` : `${ln} ${emoji}`
    const kind = (isMt ? mtKinds : mcKinds)[Math.floor(r() * (isMt ? mtKinds.length : mcKinds.length))]
    const age = r() < 0.5 ? r() * 2 * HOUR : r() * 96 * HOUR
    const hops = r() < 0.25 ? 0 : Math.floor(r() * 6)
    const hasPos = r() < 0.7
    nodes.push({
      id: isMt ? `!${hex(r, 8)}` : hex(r, 12),
      longName: kind === 'room' ? `${ln.split(' ')[0]} Chat Room` : ln,
      shortName: isMt ? (emoji && r() < 0.6 ? emoji : short(ln.replace(emoji ?? '', '').trim(), 4)) : initials(ln),
      kind,
      hwModel: isMt ? MT_HW[Math.floor(r() * MT_HW.length)] : MC_HW[Math.floor(r() * MC_HW.length)],
      publicKey: hex(r, 64),
      lastHeard: now - age,
      snr: hops === 0 ? Math.round((r() * 22 - 15) * 4) / 4 : undefined,
      rssi: hops === 0 ? Math.round(-125 + r() * 60) : undefined,
      hops,
      path: isMt ? undefined : r() < 0.3 ? undefined : Array.from({ length: hops }, () => hex(r, 2)),
      batteryPct: r() < 0.8 ? Math.floor(r() * 101) : undefined,
      voltage: undefined,
      channelUtil: isMt && r() < 0.6 ? Math.round(r() * 300) / 10 : undefined,
      airUtilTx: isMt && r() < 0.6 ? Math.round(r() * 80) / 10 : undefined,
      uptimeS: r() < 0.5 ? Math.floor(r() * 30 * 86400) : undefined,
      position: hasPos
        ? { lat: HOME.lat + (r() - 0.5) * 0.9, lon: HOME.lon + (r() - 0.5) * 1.8, alt: Math.floor(r() * 300) }
        : undefined,
      favorite: r() < 0.08,
      ignored: isMt && r() < 0.03,
    })
  }

  const channels: Channel[] = isMt
    ? [
        { index: 0, name: 'LongFast', kind: 'primary', encryption: 'default key' },
        { index: 1, name: 'Local', kind: 'secondary', encryption: 'AES-256' },
        { index: 2, name: 'Events', kind: 'secondary', encryption: 'AES-128' },
        { index: 3, name: 'Admin', kind: 'secondary', encryption: 'AES-256', muted: true },
      ]
    : [
        { index: 0, name: 'Public', kind: 'public', encryption: 'public key' },
        { index: 1, name: '#test', kind: 'hashtag', encryption: 'hashtag key' },
        { index: 2, name: '#region', kind: 'hashtag', encryption: 'hashtag key' },
        { index: 3, name: '#emergency', kind: 'hashtag', encryption: 'hashtag key' },
        { index: 4, name: 'Family', kind: 'private', encryption: 'AES-128' },
        { index: 5, name: 'Hiking crew', kind: 'private', encryption: 'AES-128' },
        { index: 6, name: '#meetup', kind: 'hashtag', encryption: 'hashtag key' },
        { index: 7, name: '#sensors', kind: 'hashtag', encryption: 'hashtag key', muted: true },
        { index: 8, name: '#trade', kind: 'hashtag', encryption: 'hashtag key' },
        { index: 9, name: 'Club ops', kind: 'private', encryption: 'AES-128' },
      ]

  const configs: ChannelConfig[] = isMt
    ? [
        { index: 0, name: '', key: Uint8Array.of(1) },
        { index: 1, name: 'Local', key: bytes(r, 32) },
        { index: 2, name: 'Events', key: bytes(r, 16) },
        { index: 3, name: 'Admin', key: bytes(r, 32) },
      ]
    : channels.map((c) => ({
        index: c.index,
        name: c.name,
        key: c.kind === 'public' ? fromHex(MC_PUBLIC) : c.kind === 'private' ? bytes(r, 16) : new Uint8Array(16),
      }))

  const peers = nodes.filter((n) => n.id !== selfId && (isMt || n.kind === 'chat'))
  const direct = nodes.filter((n) => n.id !== selfId && n.hops === 0)
  const messages: Message[] = []
  let mid = 0
  const addThread = (thread: ThreadKey, n: number, participants: MeshNode[]) => {
    const isDm = thread.startsWith('dm:')
    const sent: Message[] = []
    let t = now - n * 0.4 * HOUR - r() * HOUR
    for (let i = 0; i < n; i++) {
      t += r() * 0.6 * HOUR
      const mine = r() < 0.25
      const from = mine ? self : participants[Math.floor(r() * participants.length)]
      const earlier = sent.length && r() < 0.12 ? sent[Math.max(0, sent.length - 1 - Math.floor(r() * 4))] : undefined
      // Meshtastic: the last relay is a node heard directly, now and then an unknown or shared byte.
      const relay = mine || !isMt || from.hops === undefined ? undefined
        : from.hops === 0 ? relayByte(from.id)
        : r() < 0.85 && direct.length ? relayByte(direct[Math.floor(r() * direct.length)].id)
        : Math.floor(r() * 255) + 1
      const m: Message = {
        id: `m${mid++}`,
        thread,
        from: from.id,
        text: (!isMt && earlier && earlier.from !== from.id ? `@[${nodes.find((x) => x.id === earlier.from)!.longName}] ` : '') + CHAT[Math.floor(r() * CHAT.length)],
        ts: Math.min(t, now - 60_000),
        status: mine ? (isDm && r() < 0.85 ? 'acked' : 'sent') : 'received',
        hops: mine ? undefined : from.hops,
        hopStart: mine || !isMt ? undefined : Math.max(from.hops ?? 0, HOP_STARTS[Math.floor(r() * HOP_STARTS.length)]),
        relay,
        snr: mine ? undefined : Math.round((r() * 20 - 14) * 4) / 4,
        rssi: mine || !isMt ? undefined : Math.round(-128 + r() * 55),
        repeats: mine ? Math.floor(r() * (isMt ? 2 : 5)) : undefined,
        settled: mine ? true : undefined,
        packetId: isMt ? Math.floor(r() * 2 ** 31) + 1 : undefined,
        replyTo: isMt ? earlier?.packetId : undefined,
        pki: isMt && isDm && !mine ? true : undefined,
      }
      if (isMt && r() < 0.15) {
        const who = [...new Set(Array.from({ length: 1 + Math.floor(r() * 3) }, () => (r() < 0.2 ? self : participants[Math.floor(r() * participants.length)]).id))]
        m.reactions = who.map((w) => ({ emoji: REACTIONS[Math.floor(r() * REACTIONS.length)], from: w, ts: m.ts + 60_000 }))
      }
      sent.push(m)
      messages.push(m)
    }
  }
  for (const ch of channels) addThread(`ch:${ch.index}`, Math.floor(r() * 40) + (ch.index === 0 ? 60 : 3), peers)
  for (const p of peers.slice(3, isMt ? 8 : 6)) addThread(`dm:${p.id}`, Math.floor(r() * 12) + 2, [p])
  messages.sort((a, b) => a.ts - b.ts)

  // A day of telemetry every 30 min: the radio, and nodes that report a battery.
  const samples: Record<string, Sample[]> = {}
  for (const n of [self, ...nodes.filter((x) => x.batteryPct !== undefined).slice(0, 25)]) {
    let batt = n.batteryPct ?? 80
    let util = n.channelUtil ?? 10
    const list: Sample[] = []
    for (let i = 47; i >= 0; i--) {
      batt = Math.min(100, Math.max(5, batt + (r() - 0.55) * 3))
      util = Math.max(0, util + (r() - 0.5) * 4)
      const v: Record<string, number> = { batteryPct: Math.round(batt), voltage: Math.round((3.3 + batt / 110) * 100) / 100 }
      if (isMt) Object.assign(v, { channelUtil: Math.round(util * 10) / 10, airUtilTx: Math.round(r() * 40) / 10 })
      if (n.hops === 0 && n !== self) v.snr = Math.round(((n.snr ?? 0) + (r() - 0.5) * 6) * 4) / 4
      list.push({ ts: now - i * 0.5 * HOUR, v })
    }
    samples[n.id] = list
  }

  return { info, nodes, channels, configs, messages, samples }
}
