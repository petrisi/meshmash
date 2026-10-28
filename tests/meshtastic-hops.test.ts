// Message hops: hop_start − hop_limit, also for packets the radio queued while no client was connected.
import { describe, expect, it } from 'vitest'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { BROADCAST, Port } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { PbWriter } from '../src/lib/protocol/protobuf'
import type { Message } from '../src/lib/model/types'
import type { Transport } from '../src/lib/transport/types'
import { f32, recordingSink } from './helpers'

const FROM = 0x11223344

function setup() {
  const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write: async () => {} }
  const rec = recordingSink()
  const messages: Message[] = []
  rec.sink.message = (m) => void messages.push(m)
  new MeshtasticClient(t as unknown as Transport, rec.sink)
  /** A broadcast text packet received `ago` seconds before now. */
  const receive = (id: number, ago: number, hopStart: number, hopLimit: number) => {
    const data = new PbWriter().uint(1, Port.TEXT).bytes(2, new TextEncoder().encode('hi'))
    const p = new PbWriter().fixed32(1, FROM).fixed32(2, BROADCAST).message(4, data).fixed32(6, id)
      .fixed32(7, Math.floor(Date.now() / 1000) - ago).fixed32(8, f32(5.5))
    if (hopLimit) p.uint(9, hopLimit)
    p.uint(15, hopStart)
    t.onData(encodeFrame(new PbWriter().message(2, p).finish()))
  }
  return { rec, messages, receive }
}

describe('message hops', () => {
  it('a packet queued while no client was connected keeps its hops', () => {
    const { messages, receive } = setup()
    receive(1, 600, 3, 2)
    expect(messages[0]).toMatchObject({ hops: 1, hopStart: 3 })
  })

  it('hop_limit 0 is left out of the packet: all hops used', () => {
    const { messages, receive } = setup()
    receive(1, 0, 4, 0)
    expect(messages[0]).toMatchObject({ hops: 4, hopStart: 4 })
  })

  it('unknown without hop_start or when hop_limit exceeds it', () => {
    const { messages, receive } = setup()
    receive(1, 0, 0, 3)
    receive(2, 0, 2, 3)
    expect(messages.map((m) => m.hops)).toEqual([undefined, undefined])
  })

  it('an older queued packet leaves the node hop count alone', () => {
    const { rec, receive } = setup()
    receive(1, 60, 3, 2)
    receive(2, 600, 3, 0)
    expect(rec.nodes.get('!11223344')?.hops).toBe(1)
  })
})
