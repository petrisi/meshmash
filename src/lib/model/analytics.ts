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
