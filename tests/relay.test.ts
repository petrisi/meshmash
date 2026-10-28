// Relay byte → candidate nodes and the "via" text.
import { describe, expect, it } from 'vitest'
import { guessRelay, relayByte, relayNames } from '../src/lib/model/relay'
import type { MeshNode } from '../src/lib/model/types'

const node = (id: string, shortName: string, more: Partial<MeshNode> = {}): MeshNode =>
  ({ id, shortName, longName: shortName, kind: 'client', ...more }) as MeshNode
const at = (lat: number) => ({ position: { lat, lon: 25 } })
const SELF = node('!000000aa', 'me', at(60))

const via = (nodes: MeshNode[], byte = 0xb0) => {
  const g = guessRelay(byte, nodes, SELF)
  return `${g.likely ? 'likely ' : ''}via ${relayNames(g)}`
}

describe('relayByte', () => {
  it('last byte, 0 sent as 0xff', () => {
    expect(relayByte('!1234abb0')).toBe(0xb0)
    expect(relayByte('!12345600')).toBe(0xff)
    expect(relayByte('c0ffee')).toBeUndefined()
  })
})

describe('guessRelay', () => {
  it('one direct match is certain, farther matches ignored', () => {
    expect(via([node('!000001b0', 'zeb3', { hops: 0 }), node('!000002b0', 'far', { hops: 3 })])).toBe('via zeb3')
  })

  it('several direct matches: closest first, then last heard', () => {
    const nodes = [
      node('!000001b0', 'zen4', { hops: 0, ...at(60.3) }),
      node('!000002b0', 'koik', { hops: 0, lastHeard: 2 }),
      node('!000003b0', 'zeb3', { hops: 0, ...at(60.1) }),
      node('!000004b0', 'old', { hops: 0, lastHeard: 1 }),
    ]
    expect(via(nodes.slice(0, 2))).toBe('via zen4 or koik')
    expect(via(nodes.slice(0, 3))).toBe('via zeb3, zen4 or koik')
    expect(via(nodes)).toBe('via zeb3, zen4 or koik +1 more')
  })

  it('no direct match: likely, among farther nodes', () => {
    expect(via([node('!000001b0', 'zeb3', { hops: 2 })])).toBe('likely via zeb3')
    expect(via([node('!000001b0', 'zeb3'), node('!000002b0', 'koik', at(60.2))])).toBe('likely via koik or zeb3')
  })

  it('no match: the byte; never ourselves or the sender', () => {
    expect(via([], 0x0b)).toBe('via 0b')
    expect(via([SELF], 0xaa)).toBe('via aa')
    expect(relayNames(guessRelay(0xb0, [node('!000001b0', 'snd', { hops: 0 })], SELF, '!000001b0'))).toBe('b0')
  })
})
