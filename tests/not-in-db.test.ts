// DM peers missing from the radio's node list: which actions are offered, and that they send.
import { describe, expect, it } from 'vitest'
import { nodeActions } from '../src/lib/model/capabilities'
import type { MeshNode } from '../src/lib/model/types'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { decodeMeshPacket, Port, type MeshPacket } from '../src/lib/protocol/meshtastic/codec'
import { asBytes, fields } from '../src/lib/protocol/protobuf'
import type { Transport } from '../src/lib/transport/types'
import { recordingSink } from './helpers'

const stub: MeshNode = { id: '!d45c48d4', longName: '!d45c48d4', shortName: '48d4', kind: 'client', notInDb: true }

describe('node not in NodeDB', () => {
  it('Meshtastic offers only actions the firmware sends without a public key', () => {
    expect(nodeActions('meshtastic', stub, false).map((a) => a.id)).toEqual(['exchange-info', 'traceroute', 'req-position'])
  })

  it('MeshCore offers nothing', () => {
    expect(nodeActions('meshcore', { ...stub, id: 'aabbccddeeff', kind: 'chat' }, false)).toEqual([])
  })

  it.each([
    ['traceroute', Port.TRACEROUTE],
    ['req-position', Port.POSITION],
  ])('sends %s by node number alone', async (action, port) => {
    const packets: MeshPacket[] = []
    const write = async (b: Uint8Array) => {
      if (b[0] !== 0x94) return
      const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
      if (f) packets.push(decodeMeshPacket(asBytes(f.value)))
    }
    const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write }
    const client = new MeshtasticClient(t as unknown as Transport, recordingSink().sink)
    await client.action(action, stub.id)
    expect(packets.map((p) => [p.to, p.decoded?.portnum, p.decoded?.wantResponse])).toEqual([[0xd45c48d4, port, true]])
  })
})
