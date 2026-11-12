// Demo history for the Analytics views: 30 days of packets received while "connected".
import type { CoverageSpan, PacketRecord } from '../model/analytics'
import type { Protocol } from '../model/types'

const HOUR = 3_600_000

/** Small seeded PRNG (mulberry32), so a demo session shows the same history throughout. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, weighted: [T, number][]): T => {
  const total = weighted.reduce((s, [, w]) => s + w, 0)
  let x = r() * total
  for (const [v, w] of weighted) if ((x -= w) < 0) return v
  return weighted[weighted.length - 1][0]
}

const MT_TYPES: [string, number][] = [
  ['telemetry', 30], ['position', 22], ['nodeinfo', 14], ['text', 9], ['routing', 10],
  ['traceroute', 2], ['neighbours', 3], ['encrypted', 7], ['other', 3],
]
const MC_TYPES: [string, number][] = [
  ['advert', 26], ['channel', 24], ['dm', 8], ['ack', 14], ['request', 10], ['path', 8], ['trace', 3], ['other', 7],
]
const MT_TX: [string, number][] = [['text', 5], ['position', 2], ['nodeinfo', 2], ['traceroute', 1]]
const MC_TX: [string, number][] = [['channel', 5], ['dm', 2], ['advert', 2], ['request', 1]]

/** Channel senders not among the contacts. */
const STRANGERS = ['Kettu', 'Mobile 7', 'Lumi', 'Retki']

/** Relative activity by local hour: quiet nights, busy evenings. */
const DIURNAL = [0.35, 0.3, 0.28, 0.27, 0.3, 0.4, 0.6, 0.85, 1, 1, 0.95, 0.95, 1, 0.95, 0.9, 0.95, 1.05, 1.15, 1.3, 1.35, 1.3, 1.1, 0.8, 0.5]

export function demoAnalytics(
  protocol: Protocol,
  nodes: { id: string; longName: string }[],
  selfId: string,
  now: number,
  seed = 7,
): { records: PacketRecord[]; coverage: CoverageSpan[] } {
  const r = rng(seed)
  const mt = protocol === 'meshtastic'
  const peers = nodes.filter((n) => n.id !== selfId)
  // A few nodes send most of the traffic.
  const weighted: [(typeof peers)[number], number][] = peers.map((n, i) => [n, 1 / (1 + i * 0.35)])

  // Connected: evenings, weekend days, and the last 26 hours without a break.
  const coverage: CoverageSpan[] = []
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  for (let d = 30; d >= 2; d--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - d)
    const weekend = day.getDay() === 0 || day.getDay() === 6
    if (r() < 0.12) continue // a day without the app
    const from = day.getTime() + (weekend ? 9 : 18) * HOUR + Math.floor(r() * 40) * 60_000
    coverage.push({ start: from, end: day.getTime() + 23.5 * HOUR - Math.floor(r() * 60) * 60_000 })
  }
  coverage.push({ start: now - 26 * HOUR, end: now })

  const records: PacketRecord[] = []
  const base = mt ? 38 : 55
  for (const span of coverage) {
    for (let h = span.start; h < span.end; h += HOUR) {
      const end = Math.min(h + HOUR, span.end)
      const hour = new Date(h).getHours()
      const n = Math.round(base * DIURNAL[hour] * ((end - h) / HOUR) * (0.7 + 0.6 * r()))
      for (let i = 0; i < n; i++) {
        const ts = h + r() * (end - h)
        const type = pick(r, mt ? MT_TYPES : MC_TYPES)
        const node = pick(r, weighted)
        // MeshCore tells the sender only for adverts (and a few requests); channel texts carry
        // a name, matched to a contact where one has it.
        const known = mt || type === 'advert' || (type === 'request' && r() < 0.3) || (type === 'channel' && r() < 0.7)
        const rec: PacketRecord = {
          ts,
          dir: 'rx',
          from: known ? node.id : undefined,
          type,
          hops: Math.floor(r() * 4),
          snr: Math.round((r() * 20 - 12) * 4) / 4,
          rssi: -60 - Math.floor(r() * 60),
        }
        if ((type === 'nodeinfo' || type === 'advert' || type === 'channel') && known) rec.name = node.longName
        if (type === 'channel' && !known && r() < 0.6) rec.name = STRANGERS[Math.floor(r() * STRANGERS.length)]
        records.push(rec)
        // Repeats of the same MeshCore packet heard via other paths.
        if (!mt && r() < 0.35) records.push({ ...rec, ts: ts + 400 + r() * 3000, dup: true, hops: (rec.hops ?? 0) + 1 })
      }
      for (let i = 0, k = Math.round(r() * 4 * DIURNAL[hour]); i < k; i++) {
        records.push({ ts: h + r() * (end - h), dir: 'tx', from: selfId, type: pick(r, mt ? MT_TX : MC_TX) })
      }
    }
  }
  return { records: records.sort((a, b) => a.ts - b.ts), coverage }
}
