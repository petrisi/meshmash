import type { Capabilities, MeshNode, NodeKind, Protocol } from './types'

export function capabilitiesFor(protocol: Protocol): Capabilities {
  return protocol === 'meshtastic'
    ? { maxChannels: 8, maxNameLen: 39, maxShortNameLen: 4, messageMaxBytes: 200 }
    : { maxChannels: 40, maxNameLen: 31, maxShortNameLen: 2, messageMaxBytes: 133 }
}

/** How long after sending we keep counting rebroadcasts. */
export const REPEAT_WINDOW_MS = 30_000
/** Rebroadcasts needed within the window for a green tick. */
export const REPEAT_OK = 1

export interface NodeAction {
  id: string
  label: string
  primary?: boolean
  danger?: boolean
}

function mtPeerActions(node: MeshNode): NodeAction[] {
  return [
    { id: 'dm', label: 'Direct message', primary: true },
    { id: 'traceroute', label: 'Traceroute' },
    { id: 'req-neighbours', label: 'Neighbours' },
    { id: 'req-position', label: 'Request position' },
    { id: 'req-telemetry', label: 'Request telemetry' },
    { id: 'exchange-info', label: 'Exchange user info' },
    { id: 'favorite', label: node.favorite ? 'Unfavorite' : 'Favorite' },
    // Ignored nodes' packets are dropped by our radio: not shown, not rebroadcast.
    { id: 'ignore', label: node.ignored ? 'Unignore' : 'Ignore', danger: !node.ignored },
    { id: 'remove', label: 'Remove from NodeDB', danger: true },
  ]
}

const MC_BY_KIND: Partial<Record<NodeKind, NodeAction[]>> = {
  chat: [
    { id: 'dm', label: 'Direct message', primary: true },
    { id: 'path-discovery', label: 'Find path' },
    { id: 'reset-path', label: 'Reset path' },
    { id: 'req-telemetry', label: 'Request telemetry' },
    { id: 'share', label: 'Share contact' },
    { id: 'remove', label: 'Remove contact', danger: true },
  ],
  repeater: [
    { id: 'login', label: 'Log in', primary: true },
    { id: 'req-status', label: 'Status' },
    { id: 'req-telemetry', label: 'Telemetry' },
    { id: 'req-neighbours', label: 'Neighbours' },
    { id: 'req-owner', label: 'Owner info' },
    { id: 'trace', label: 'Trace path' },
    { id: 'path-discovery', label: 'Find path' },
    { id: 'reset-path', label: 'Reset path' },
    { id: 'remove', label: 'Remove contact', danger: true },
  ],
  room: [
    { id: 'dm', label: 'Open room', primary: true },
    { id: 'login', label: 'Log in' },
    { id: 'req-status', label: 'Status' },
    { id: 'req-telemetry', label: 'Telemetry' },
    { id: 'trace', label: 'Trace path' },
    { id: 'path-discovery', label: 'Find path' },
    { id: 'reset-path', label: 'Reset path' },
    { id: 'remove', label: 'Remove contact', danger: true },
  ],
  sensor: [
    { id: 'req-telemetry', label: 'Request telemetry', primary: true },
    { id: 'login', label: 'Log in' },
    { id: 'path-discovery', label: 'Find path' },
    { id: 'remove', label: 'Remove contact', danger: true },
  ],
}

/** Radio-level actions, shown in the top bar and on the own node. */
export function radioActions(protocol: Protocol): NodeAction[] {
  return protocol === 'meshcore'
    ? [
        { id: 'advert-zero', label: 'Advert (zero hop)' },
        { id: 'advert-flood', label: 'Advert (flood)' },
        { id: 'discover', label: 'Discover nearby' },
      ]
    : [
        { id: 'send-nodeinfo', label: 'Send node info' },
        { id: 'send-position', label: 'Send position' },
      ]
}

export function nodeActions(protocol: Protocol, node: MeshNode, isSelf: boolean): NodeAction[] {
  if (isSelf) return [...radioActions(protocol), { id: 'configure', label: 'Configure radio' }]
  if (protocol === 'meshtastic') return mtPeerActions(node)
  return MC_BY_KIND[node.kind] ?? MC_BY_KIND.chat!
}

export const KIND_LABEL: Record<NodeKind, string> = {
  client: 'Client',
  client_mute: 'Client mute',
  router: 'Router',
  tracker: 'Tracker',
  sensor: 'Sensor',
  chat: 'Companion',
  repeater: 'Repeater',
  room: 'Room server',
}
