// Node info and position broadcasts go on the channel given by the app.
import { describe, expect, it } from 'vitest'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { decodeMeshPacket, type MeshPacket } from '../src/lib/protocol/meshtastic/codec'
import { asBytes, fields } from '../src/lib/protocol/protobuf'
import type { Transport } from '../src/lib/transport/types'
import { recordingSink } from './helpers'

function setup() {
  const packets: MeshPacket[] = []
  const write = async (b: Uint8Array) => {
    if (b[0] !== 0x94) return
    const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
    if (f) packets.push(decodeMeshPacket(asBytes(f.value)))
  }
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write }
  const client = new MeshtasticClient(t as unknown as Transport, recordingSink().sink)
  const inner = client as unknown as { myNum: number; nodes: Map<number, unknown> }
  inner.myNum = 0x11223344
  inner.nodes.set(0x11223344, {
    num: 0x11223344,
    user: { id: '!11223344', longName: 'Test', shortName: 'T' },
    position: { lat: 60.1, lon: 24.9 },
  })
  return { client, packets }
}

describe('Meshtastic broadcasts', () => {
  it.each(['send-nodeinfo', 'send-position'])('%s uses the given channel, else the primary', async (action) => {
    // A client per send: the second would wait for the radio to accept the first.
    const a = setup()
    await a.client.action(action, '!11223344', { channel: 2 })
    const b = setup()
    await b.client.action(action, '!11223344')
    expect([...a.packets, ...b.packets].map((p) => [p.to, p.channel ?? 0])).toEqual([
      [0xffffffff, 2],
      [0xffffffff, 0],
    ])
  })
})

describe('Meshtastic requests', () => {
  type Inner = {
    nodes: Map<number, { num: number; channel?: number; lastHeard?: number }>
    channelInfos: { index: number; role: number }[]
    onPacket: (p: MeshPacket) => void
  }
  const PEER = 0x0a0b0c0d
  const withChannels = (roles: number[]) => {
    const s = setup()
    const inner = s.client as unknown as Inner
    inner.channelInfos = roles.map((role, index) => ({ index, role }))
    return { ...s, inner }
  }
  const traceOn = async (s: ReturnType<typeof withChannels>) => {
    await s.client.action('traceroute', '!0a0b0c0d')
    return s.packets.map((p) => [p.to, p.channel ?? 0])
  }

  it('go on the channel the node was last heard on', async () => {
    const s = withChannels([1, 2, 2])
    s.inner.nodes.set(PEER, { num: PEER, channel: 2 })
    expect(await traceOn(s)).toEqual([[PEER, 2]])
  })

  it('go on the primary for unknown nodes and for a channel no longer in use', async () => {
    expect(await traceOn(withChannels([1, 2]))).toEqual([[PEER, 0]])
    const s = withChannels([1, 2, 0])
    s.inner.nodes.set(PEER, { num: PEER, channel: 2 })
    expect(await traceOn(s)).toEqual([[PEER, 0]])
  })

  it('the channel follows packets decoded with a channel key only', () => {
    const s = withChannels([1, 2, 2])
    let rxTime = Math.floor(Date.now() / 1000) - 100
    const hear = (p: Partial<MeshPacket>) =>
      s.inner.onPacket({ from: PEER, to: 0xffffffff, id: 1, channel: 0, rxTime: ++rxTime, ...p } as MeshPacket)
    hear({ channel: 2, decoded: { portnum: 1, payload: new Uint8Array() } as MeshPacket['decoded'] })
    expect(s.inner.nodes.get(PEER)?.channel).toBe(2)
    hear({ channel: 0, pkiEncrypted: true, decoded: { portnum: 1, payload: new Uint8Array() } as MeshPacket['decoded'] })
    hear({ channel: 0x5c })
    expect(s.inner.nodes.get(PEER)?.channel).toBe(2)
    hear({ channel: 1, decoded: { portnum: 1, payload: new Uint8Array() } as MeshPacket['decoded'] })
    expect(s.inner.nodes.get(PEER)?.channel).toBe(1)
  })
})
