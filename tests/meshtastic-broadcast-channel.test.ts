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
