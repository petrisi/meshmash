// Node list filters shared by the Nodes and Map views.
import { KIND_LABEL } from './capabilities'
import type { MeshNode, NodeKind, Protocol } from './types'

export interface NodeFilter {
  id: string
  label: string
  test: (n: MeshNode) => boolean
}

/** `withIgnored`: add the Meshtastic "Ignored" filter. */
export function nodeFilters(proto: Protocol, withIgnored = false): NodeFilter[] {
  return proto === 'meshcore'
    ? [
        { id: 'all', label: 'All', test: () => true },
        ...(['chat', 'repeater', 'room', 'sensor'] as NodeKind[]).map((k) => ({
          id: k,
          label: KIND_LABEL[k] + 's',
          test: (n: MeshNode) => n.kind === k,
        })),
      ]
    : [
        { id: 'all', label: 'All', test: () => true },
        { id: 'fav', label: 'Favorites', test: (n) => !!n.favorite },
        { id: 'direct', label: 'Direct', test: (n) => n.hops === 0 },
        { id: '2h', label: 'Heard 2h', test: (n) => !!n.lastHeard && Date.now() - n.lastHeard < 7_200_000 },
        { id: 'infra', label: 'Routers', test: (n) => n.kind === 'router' },
        ...(withIgnored ? [{ id: 'ignored', label: 'Ignored', test: (n: MeshNode) => !!n.ignored }] : []),
      ]
}

/** Name, short name or id contains the query (case-insensitive). */
export function matchesQuery(n: MeshNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || n.longName.toLowerCase().includes(q) || n.shortName.toLowerCase().includes(q) || n.id.includes(q)
}
