// Protocol-agnostic domain model. Protocol adapters translate into these types;
// the UI never inspects raw Meshtastic/MeshCore structures.

export type Protocol = 'meshtastic' | 'meshcore'

/** Meshtastic device roles and MeshCore contact types, unified. */
export type NodeKind =
  | 'client'
  | 'client_mute'
  | 'router'
  | 'tracker'
  | 'sensor'
  | 'chat'
  | 'repeater'
  | 'room'

export interface Position {
  lat: number
  lon: number
  alt?: number
  /** Meshtastic: coordinates kept to this many bits, centred in the cell (32 or unset = exact). */
  precisionBits?: number
}

export interface ContactSettings {
  /** Off: every advert is added. On: only the types below. */
  manual: boolean
  chat: boolean
  repeater: boolean
  room: boolean
  sensor: boolean
  /** When the table is full, replace the oldest non-favourite contact. */
  overwriteOldest: boolean
  /** 0 = any distance, 1 = direct only, N = up to N-1 hops. */
  maxHops: number
}

export interface MeshNode {
  /** Stable key: Meshtastic "!hex" node id, MeshCore public key prefix. */
  id: string
  longName: string
  shortName: string
  kind: NodeKind
  /** Protocol-specific role name, e.g. Meshtastic "ROUTER_LATE". */
  role?: string
  hwModel?: string
  publicKey?: string
  /** Epoch ms. */
  lastHeard?: number
  snr?: number
  rssi?: number
  /** Hops away; 0 = direct. Undefined = unknown. */
  hops?: number
  /** MeshCore: known out-path as hop hashes. Empty array = direct, undefined = flood. */
  path?: string[]
  batteryPct?: number
  voltage?: number
  channelUtil?: number
  airUtilTx?: number
  uptimeS?: number
  position?: Position
  favorite?: boolean
  /** Meshtastic: packets from this node are dropped by our radio. */
  ignored?: boolean
  viaMqtt?: boolean
  /** MeshCore: heard, but not in the radio's contacts (manual add mode or table full). */
  unsaved?: boolean
}

export type ChannelKind = 'primary' | 'secondary' | 'public' | 'hashtag' | 'private'

export interface Channel {
  index: number
  name: string
  kind: ChannelKind
  /** Human summary of key, e.g. "AES-256", "default key", "none". */
  encryption: string
  muted?: boolean
}

/**
 * Outgoing: pending (queued to radio) → sent (radio transmitted) → acked (DM recipient
 * confirmed) | failed. Incoming messages are "received".
 */
export type MessageStatus = 'pending' | 'sent' | 'acked' | 'failed' | 'received'

/** Thread keys: "ch:<index>" or "dm:<nodeId>". */
export type ThreadKey = `ch:${number}` | `dm:${string}`

export interface Message {
  id: string
  thread: ThreadKey
  from: string
  /** Sender name when `from` is not a known node (MeshCore channel messages). */
  fromName?: string
  text: string
  ts: number
  status: MessageStatus
  /** Hops taken to reach us (Meshtastic: hop_start - hop_limit; MeshCore: path length). */
  hops?: number
  /** Meshtastic only: sender's initial hop limit. */
  hopStart?: number
  snr?: number
  rssi?: number
  /** Outgoing: rebroadcasts of this packet heard by our radio. */
  repeats?: number
  /** Outgoing: the repeat-listening window has closed. */
  settled?: boolean
  /** Meshtastic packet id, for replies and reactions. */
  packetId?: number
  /** Meshtastic: packet id of the message this one answers. */
  replyTo?: number
  /** Incoming only, transient: this is a reaction to `replyTo`, not a message. */
  reaction?: boolean
  reactions?: { emoji: string; from: string; ts: number }[]
  /** Meshtastic DM encrypted with the node's public key (PKI). */
  pki?: boolean
  /** Outgoing, Meshtastic: hop limit chosen instead of the radio default. */
  hopLimit?: number
}

export interface RadioParams {
  region?: string
  preset?: string
  freqMHz?: number
  bwKHz?: number
  sf?: number
  cr?: number
  txPowerDbm?: number
}

export interface RadioInfo {
  protocol: Protocol
  firmware: string
  hwModel: string
  nodeId: string
  longName: string
  shortName: string
  radio: RadioParams
  batteryPct?: number
  voltage?: number
  position?: Position
}

export interface Capabilities {
  maxChannels: number
  maxNameLen: number
  maxShortNameLen: number
  messageMaxBytes: number
  /** Meshtastic: the radio's configured hop limit; set when messages can override it. */
  hopLimit?: number
}

/** Data fetched from a node on request (MeshCore servers and telemetry). */
export interface RemoteData {
  login?: { role: string; ts: number }
  status?: { ts: number; fields: { label: string; value: string }[] }
  telemetry?: { ts: number; readings: { channel: number; type: number; name: string; value: string }[] }
  neighbours?: {
    ts: number
    total: number
    /** snrThere: how that node heard us (discovery only). */
    list: { id: string; heardSecsAgo: number; snr: number; snrThere?: number }[]
  }
  owner?: { ts: number; text: string }
  cli?: { ts: number; dir: 'out' | 'in'; text: string }[]
}

/** One telemetry sample: metric name → value, e.g. battery, voltage, channelUtil, temperature. */
export interface Sample {
  ts: number
  v: Record<string, number>
}

/** What we keep per node across sessions. */
export interface NodeData {
  traces?: TracerouteResult[]
  remote?: RemoteData
  samples?: Sample[]
}

/** Outcome of a node action that waits for an answer over the air. */
export interface ActionResult {
  action: string
  state: 'pending' | 'ok' | 'failed'
  ts: number
  text?: string
}

export interface TracerouteResult {
  nodeId: string
  ts: number
  /** Node ids, origin first, target last. */
  towards: string[]
  back?: string[]
  /** SNR per hop, dB. */
  snrTowards: number[]
  snrBack?: number[]
  /** Request to answer, ms (includes serial polling delays). */
  rttMs?: number
  /** MeshCore path discovery: the route found can be saved to the contact. */
  discovered?: boolean
}
