// Outgoing text through the client: ids and reply fields as written to the radio.
import { describe, expect, it } from 'vitest'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { decodeMeshPacket, type MeshPacket } from '../src/lib/protocol/meshtastic/codec'
import { asBytes, fields } from '../src/lib/protocol/protobuf'
import type { SerialTransport } from '../src/lib/transport/serial'
import { recordingSink } from './helpers'

function setup() {
  const packets: MeshPacket[] = []
  const write = async (b: Uint8Array) => {
    if (b[0] !== 0x94) return
    const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
    if (f) packets.push(decodeMeshPacket(asBytes(f.value)))
  }
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write }
  const rec = recordingSink()
  const ids = new Map<string, number>()
  rec.sink.updateMessage = (id, patch) => void (patch.packetId !== undefined && ids.set(id, patch.packetId))
  const client = new MeshtasticClient(t as unknown as SerialTransport, rec.sink)
  return { client, packets, ids }
}

describe('Meshtastic sendText', () => {
  it('sets the packet id before the radio takes the packet', async () => {
    const { client, packets, ids } = setup()
    void client.sendText('ch:0', 'first', 'a')
    // Queued behind the first, which the radio has not taken yet.
    void client.sendText('ch:0', 'second', 'b')
    expect([...ids.keys()]).toEqual(['a', 'b'])
    await new Promise((r) => setTimeout(r, 10))
    expect(packets).toHaveLength(1)
    expect(packets[0].id).toBe(ids.get('a'))
  })

  it('writes reply_id and, for reactions, emoji', async () => {
    const { client, packets } = setup()
    await client.sendText('dm:!d45c48d4', 'yes', 'a', { replyTo: 0x1234abcd })
    expect(packets[0].decoded).toMatchObject({ replyId: 0x1234abcd })
    expect(packets[0].decoded?.emoji).toBeUndefined()

    const r = setup()
    await r.client.sendText('ch:0', '👍', 'b', { replyTo: 42, reaction: true })
    expect(r.packets[0].decoded).toMatchObject({ replyId: 42, emoji: 1 })
  })
})
