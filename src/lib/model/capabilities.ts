import type { Capabilities, MeshNode, NodeKind, Protocol } from './types'

export function capabilitiesFor(protocol: Protocol): Capabilities {
  return protocol === 'meshtastic'
    ? { maxChannels: 8, maxNameLen: 39, maxShortNameLen: 4, messageMaxBytes: 200 }
    : { maxChannels: 40, maxNameLen: 31, maxShortNameLen: 2, messageMaxBytes: 133 }
}

export interface NodeAction {
  id: string
  label: string
  primary?: boolean
  danger?: boolean
}

const MT_PEER: NodeAction[] = [
  { id: 'dm', label: 'Direct message', primary: true },
  { id: 'traceroute', label: 'Traceroute' },
  { id: 'req-position', label: 'Request position' },
  { id: 'req-telemetry', label: 'Request telemetry' },
  { id: 'exchange-info', label: 'Exchange user info' },
  { id: 'favorite', label: 'Toggle favorite' },
  { id: 'remove', label: 'Remove from NodeDB', danger: true },
]

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
    { id: 'req-status', label: 'Request status' },
    { id: 'trace', label: 'Trace path' },
    { id: 'path-discovery', label: 'Find path' },
    { id: 'req-telemetry', label: 'Request telemetry' },
    { id: 'remove', label: 'Remove contact', danger: true },
  ],
  room: [
    { id: 'login', label: 'Join room', primary: true },
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

export function nodeActions(protocol: Protocol, node: MeshNode, isSelf: boolean): NodeAction[] {
  if (isSelf) return [{ id: 'configure', label: 'Configure radio' }]
  if (protocol === 'meshtastic') return MT_PEER
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
