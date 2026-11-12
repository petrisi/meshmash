// Packet records for the Analytics views: one per packet received or sent, kept per radio.
import type { Protocol } from './types'

export interface PacketRecord {
  /** Epoch ms: reception time (Meshtastic: the radio's rx_time where given), or when sent. */
  ts: number
  dir: 'rx' | 'tx'
  /** Sender node id; undefined when the packet does not tell it for certain. */
  from?: string
  /** Type group, see PACKET_TYPES. */
  type: string
  channel?: number
  hops?: number
  snr?: number
  rssi?: number
  mqtt?: boolean
  /** Sender's name where the packet carries it (node info, advert). */
  name?: string
  /** MeshCore: another copy of a packet already recorded (a repeat via a different path). */
  dup?: boolean
  /** Held by the radio while no app was connected; received outside connected time. */
  queued?: boolean
}

export interface CoverageSpan {
  start: number
  end: number
}

export const RETENTION_DAYS = 31
export const RETENTION_MS = RETENTION_DAYS * 86_400_000
/** Most records kept per radio; the oldest go first. */
export const PACKETS_CAP = 300_000

export interface PacketType {
  id: string
  label: string
}

export const PACKET_TYPES: Record<Protocol, PacketType[]> = {
  meshtastic: [
    { id: 'text', label: 'Text' },
    { id: 'position', label: 'Position' },
    { id: 'nodeinfo', label: 'Node info' },
    { id: 'telemetry', label: 'Telemetry' },
    { id: 'routing', label: 'Routing' },
    { id: 'traceroute', label: 'Traceroute' },
    { id: 'neighbours', label: 'Neighbours' },
    { id: 'encrypted', label: 'Encrypted' },
    { id: 'other', label: 'Other' },
  ],
  meshcore: [
    { id: 'advert', label: 'Advert' },
    { id: 'dm', label: 'Direct text' },
    { id: 'channel', label: 'Channel text' },
    { id: 'ack', label: 'ACK' },
    { id: 'request', label: 'Request' },
    { id: 'path', label: 'Path' },
    { id: 'trace', label: 'Trace' },
    { id: 'other', label: 'Other' },
  ],
}

/** Meshtastic port number to type group; undefined port = could not be decrypted. */
export function mtPacketType(portnum: number | undefined): string {
  if (portnum === undefined) return 'encrypted'
  return MT_PORT_TYPE[portnum] ?? 'other'
}

const MT_PORT_TYPE: Record<number, string> = {
  1: 'text', // TEXT_MESSAGE_APP
  7: 'text', // TEXT_MESSAGE_COMPRESSED_APP
  3: 'position',
  4: 'nodeinfo',
  5: 'routing',
  67: 'telemetry',
  70: 'traceroute',
  71: 'neighbours',
}

/** MeshCore over-the-air payload type to type group. */
export function mcPacketType(payloadType: number): string {
  return MC_PAYLOAD_TYPE[payloadType] ?? 'other'
}

const MC_PAYLOAD_TYPE: Record<number, string> = {
  0: 'request', // REQ
  1: 'request', // RESPONSE
  2: 'dm', // TXT_MSG
  3: 'ack',
  4: 'advert',
  5: 'channel', // GRP_TXT
  7: 'request', // ANON_REQ
  8: 'path',
  9: 'trace',
}

/**
 * Recognises repeats of the same MeshCore packet: the same payload heard again via another
 * path. Keyed like the firmware's packet hash (payload type, TRACE path length, payload).
 */
export class RepeatFilter {
  private seen = new Map<string, number>()

  constructor(private windowMs = 10 * 60_000) {}

  /** True if this key was seen within the window; records it either way. */
  repeat(key: string, now: number): boolean {
    const last = this.seen.get(key)
    this.seen.set(key, now)
    if (this.seen.size > 4000) {
      for (const [k, t] of this.seen) if (now - t > this.windowMs) this.seen.delete(k)
    }
    return last !== undefined && now - last <= this.windowMs
  }
}

// Aggregation for the charts.

export type ActivityRange = '24h' | '7d' | '30d'

export interface Bucket {
  start: number
  end: number
  rx: number
  tx: number
  /** Milliseconds of the bucket during which a radio was connected. */
  coveredMs: number
}

export interface RecordFilter {
  /** Type groups to keep; null keeps all. */
  types: Set<string> | null
  /** MeshCore: count repeats of a packet already counted. */
  repeats: boolean
}

export const keepRecord = (r: PacketRecord, f: RecordFilter) => (f.repeats || !r.dup) && (!f.types || f.types.has(r.type))

const HOUR = 3_600_000

/**
 * Bucket edges ending at the next local hour (24 h, 7 days: hourly buckets) or the next local
 * midnight (30 days: daily buckets, 23 or 25 h long across a DST change).
 */
export function bucketEdges(range: ActivityRange, now: number): number[] {
  const d = new Date(now)
  if (range === '30d') {
    d.setHours(0, 0, 0, 0)
    return Array.from({ length: 31 }, (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29 + i).getTime())
  }
  d.setMinutes(0, 0, 0)
  const end = d.getTime() + HOUR
  const n = range === '24h' ? 24 : 168
  return Array.from({ length: n + 1 }, (_, i) => end - (n - i) * HOUR)
}

/** Overlap of the spans with [a, b). */
export function coveredMs(spans: CoverageSpan[], a: number, b: number): number {
  let ms = 0
  for (const s of spans) ms += Math.max(0, Math.min(b, s.end) - Math.max(a, s.start))
  return ms
}

/** Index of the bucket holding ts, or -1 outside. */
function bucketOf(edges: number[], ts: number): number {
  if (ts < edges[0] || ts >= edges[edges.length - 1]) return -1
  let lo = 0
  let hi = edges.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts >= edges[mid]) lo = mid
    else hi = mid
  }
  return lo
}

export function activity(recs: PacketRecord[], spans: CoverageSpan[], range: ActivityRange, now: number, f: RecordFilter): Bucket[] {
  const edges = bucketEdges(range, now)
  const out: Bucket[] = edges.slice(0, -1).map((start, i) => ({ start, end: edges[i + 1], rx: 0, tx: 0, coveredMs: coveredMs(spans, start, Math.min(edges[i + 1], now)) }))
  for (const r of recs) {
    if (!keepRecord(r, f)) continue
    const i = bucketOf(edges, r.ts)
    if (i >= 0) out[i][r.dir]++
  }
  return out
}

/** Round axis maximum and step for about four gridlines; whole numbers only. */
export function niceScale(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 }
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!)
  return { top: Math.ceil(max / step) * step, step }
}

// Time of day: packets by local hour of reception, over all stored data.

export type DaySet = 'all' | 'weekdays' | 'weekends'

export interface HourOfDay {
  hour: number
  /** Packets received / sent in this hour of the day, over the whole period. */
  rx: number
  tx: number
  /** Live packets only (not held by the radio): the numerators of the per-hour rates. */
  rxLive: number
  txLive: number
  /** Connected time in this hour of the day, summed over days. */
  coveredMs: number
  /** Days with any connected time in this hour. */
  days: number
}

const inSet = (ts: number, set: DaySet) => {
  if (set === 'all') return true
  const wd = new Date(ts).getDay()
  return (wd === 0 || wd === 6) === (set === 'weekends')
}

export function timeOfDay(recs: PacketRecord[], spans: CoverageSpan[], f: RecordFilter, set: DaySet): HourOfDay[] {
  const out: HourOfDay[] = Array.from({ length: 24 }, (_, hour) => ({ hour, rx: 0, tx: 0, rxLive: 0, txLive: 0, coveredMs: 0, days: 0 }))
  for (const r of recs) {
    if (!keepRecord(r, f) || !inSet(r.ts, set)) continue
    const h = out[new Date(r.ts).getHours()]
    h[r.dir]++
    if (!r.queued) h[r.dir === 'rx' ? 'rxLive' : 'txLive']++
  }
  // Connected time, cut at local hour boundaries.
  const days: Set<string>[] = Array.from({ length: 24 }, () => new Set())
  for (const s of spans) {
    let t = s.start
    while (t < s.end) {
      const d = new Date(t)
      d.setMinutes(0, 0, 0)
      d.setHours(d.getHours() + 1)
      const next = Math.min(d.getTime(), s.end)
      if (inSet(t, set)) {
        const at = new Date(t)
        out[at.getHours()].coveredMs += next - t
        days[at.getHours()].add(at.toDateString())
      }
      t = next
    }
  }
  days.forEach((d, i) => (out[i].days = d.size))
  return out
}
