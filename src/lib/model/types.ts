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
}
