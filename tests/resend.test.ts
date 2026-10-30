// Resending an unacknowledged DM: when it is offered, and what goes to the radio.
import { describe, expect, it } from 'vitest'
import { canResend, deliveryState } from '../src/lib/model/delivery'
import type { Message } from '../src/lib/model/types'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Cmd, type Contact, ContactType, Resp } from '../src/lib/protocol/meshcore/codec'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { decodeMeshPacket, type MeshPacket } from '../src/lib/protocol/meshtastic/codec'
import { asBytes, fields } from '../src/lib/protocol/protobuf'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

const SELF = '!00000001'
const dm = (patch: Partial<Message>): Message => ({ id: 'a', thread: 'dm:!00000002', from: SELF, text: 'hi', ts: 0, status: 'sent', ...patch })

describe('canResend', () => {
  it('DMs without a recipient ACK, once the outcome is in', () => {
    expect(canResend(dm({ status: 'failed', settled: true }), SELF)).toBe(true)
    expect(canResend(dm({ status: 'pending', settled: true }), SELF)).toBe(true) // unknown
    expect(canResend(dm({ status: 'sent', settled: true }), SELF)).toBe(true) // nothing heard
    expect(canResend(dm({ status: 'sent', settled: true, repeats: 1 }), SELF)).toBe(true) // implicit ACK only
  })
  it('not while waiting, once acknowledged, at hop limit 0, on channels or for others', () => {
    expect(canResend(dm({ status: 'sent' }), SELF)).toBe(false)
    expect(canResend(dm({ status: 'pending' }), SELF)).toBe(false)
    expect(canResend(dm({ status: 'acked', settled: true }), SELF)).toBe(false)
    expect(canResend(dm({ status: 'sent', settled: true, hopLimit: 0 }), SELF)).toBe(false)
    expect(canResend(dm({ status: 'failed', settled: true, thread: 'ch:0' }), SELF)).toBe(false)
    expect(canResend(dm({ status: 'failed', settled: true, from: '!00000003' }), SELF)).toBe(false)
  })
  it('matches the shown states', () => {
    expect(deliveryState(dm({ status: 'sent', settled: true, repeats: 1 }), 'meshtastic')).toBe('ok')
    expect(deliveryState(dm({ status: 'acked', settled: true }), 'meshtastic')).toBe('delivered')
    expect(deliveryState(dm({ status: 'pending', settled: true }), 'meshcore')).toBe('unknown')
  })
})

describe('Meshtastic resend', () => {
  it('new packet id (the radio drops repeated ids), keeps want_ack, reply and hop limit', async () => {
    const packets: MeshPacket[] = []
    const write = async (b: Uint8Array) => {
      const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
      if (f) packets.push(decodeMeshPacket(asBytes(f.value)))
    }
    const t = { label: 'x', onData: (_: Uint8Array) => {}, onClose: () => {}, write }
    const rec = recordingSink()
    let newId: number | undefined
    rec.sink.updateMessage = (_id, p) => void (newId = p.packetId ?? newId)
    const client = new MeshtasticClient(t as unknown as Transport, rec.sink)
    await client.sendText('dm:!d45c48d4', 'hi', 'a', { replyTo: 7, hopLimit: 5, resend: { attempt: 1 } })
    expect(packets[0]).toMatchObject({ id: newId, wantAck: true, hopLimit: 5, decoded: { replyId: 7 } })
  })
})

describe('MeshCore resend', () => {
  function setup() {
    const sent: Uint8Array[] = []
    const t = {
      label: 'x',
      onData: (_: Uint8Array) => {},
      onClose: () => {},
      write: async (b: Uint8Array) => {
        sent.push(b.subarray(3))
        setTimeout(() => t.onData(mcIn(Uint8Array.of(Resp.SENT, 0, 1, 2, 3, 4, 0x10, 0x27, 0, 0))))
      },
    }
    const rec = recordingSink()
    const patches: Partial<Message>[] = []
    rec.sink.updateMessage = (_id, p) => void patches.push(p)
    const client = new MeshCoreClient(t as unknown as Transport, rec.sink)
    const c = { publicKey: Uint8Array.from({ length: 32 }, (_, i) => i), type: ContactType.CHAT, name: 'x' } as Contact
    ;(client as unknown as { contacts: Map<string, Contact> }).contacts.set('000102030405', c)
    return { client, sent, patches }
  }

  it('first send stores the timestamp; a resend reuses it with the next attempt', async () => {
    const a = setup()
    await a.client.sendText('dm:000102030405', 'hi', 'a')
    const ts = a.patches.find((p) => p.senderTs !== undefined)?.senderTs
    expect(ts).toBeGreaterThan(0)
    expect([...a.sent[0].subarray(0, 3)]).toEqual([Cmd.SEND_TXT_MSG, 0, 0])

    const b = setup()
    await b.client.sendText('dm:000102030405', 'hi', 'a', { resend: { senderTs: 0x11223344, attempt: 1 } })
    expect([...b.sent[0].subarray(0, 7)]).toEqual([Cmd.SEND_TXT_MSG, 0, 1, 0x44, 0x33, 0x22, 0x11])
    expect(b.patches.find((p) => p.senderTs !== undefined)?.senderTs).toBe(0x11223344)
  })
})
