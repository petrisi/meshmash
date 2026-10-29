// Radio hop limit: set_config keeps the rest of the LoRa section; the client reads it back.
import { describe, expect, it } from 'vitest'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { Admin, decodeMeshPacket, encodeSetHopLimit, Port } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { asBytes, fields, PbWriter } from '../src/lib/protocol/protobuf'
import type { Transport } from '../src/lib/transport/types'
import { recordingSink } from './helpers'

// use_preset, region EU_868, hop_limit 3, tx_enabled, tx_power 27
const LORA = new PbWriter().bool(1, true).uint(7, 3).uint(8, 3).bool(9, true).uint(10, 27).finish()

/** LoRa fields of a set_config AdminMessage. */
function loraOf(admin: Uint8Array) {
  const config = asBytes([...fields(admin)].find((f) => f.no === Admin.SET_CONFIG)!.value)
  return new Map([...fields(asBytes([...fields(config)].find((f) => f.no === 6)!.value))].map((f) => [f.no, f.value]))
}

describe('encodeSetHopLimit', () => {
  it('replaces hop_limit, keeps the other fields', () => {
    const l = loraOf(encodeSetHopLimit(LORA, 5))
    expect([...l]).toEqual([[1, 1], [7, 3], [9, 1], [10, 27], [8, 5]])
  })
  it('0 is left out', () => {
    expect(loraOf(encodeSetHopLimit(LORA, 0)).has(8)).toBe(false)
  })
})

const fromRadio = (no: number, body: Uint8Array) => encodeFrame(new PbWriter().bytes(no, body).finish())

describe('client setHopLimit', () => {
  function setup(keep = true) {
    let stored = LORA
    const t = {
      label: 'x',
      onData: (_: Uint8Array) => {},
      onClose: () => {},
      write: async (b: Uint8Array) => {
        const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
        if (!f) return
        const p = decodeMeshPacket(asBytes(f.value))
        setTimeout(() => t.onData(fromRadio(11, new PbWriter().uint(4, p.id).finish())))
        const admin = [...fields(p.decoded!.payload!)][0]
        if (admin.no === Admin.SET_CONFIG && keep) {
          stored = asBytes([...fields(asBytes(admin.value))][0].value)
        } else if (admin.no === Admin.GET_CONFIG_REQUEST) {
          const res = new PbWriter().message(Admin.GET_CONFIG_RESPONSE, new PbWriter().bytes(6, stored))
          const data = new PbWriter().uint(1, Port.ADMIN).message(2, res).fixed32(6, p.id)
          setTimeout(() => t.onData(fromRadio(2, new PbWriter().fixed32(1, 0).fixed32(2, 0).message(4, data).fixed32(6, 99).finish())))
        }
      },
    }
    const client = new MeshtasticClient(t as unknown as Transport, recordingSink().sink)
    t.onData(fromRadio(5, new PbWriter().bytes(6, LORA).finish()))
    return client
  }

  it('writes and reads back', async () => {
    const client = setup()
    await client.setHopLimit(0)
    await client.setHopLimit(6)
    expect((client as unknown as { lora: { hopLimit?: number } }).lora.hopLimit).toBe(6)
  })

  it('fails when the radio keeps the old value', async () => {
    await expect(setup(false).setHopLimit(5)).rejects.toThrow(/did not keep/)
  })
})
