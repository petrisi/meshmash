// Channel editing: keys, identity, the set/get layouts, and both clients against fake radios.
import { describe, expect, it } from 'vitest'
import { channelReplaced, parseKey, toBase64, toHex } from '../src/lib/model/channels'
import { LeReader } from '../src/lib/protocol/bytes'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Cmd, cmdSetChannel, Resp } from '../src/lib/protocol/meshcore/codec'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { Admin, decodeMeshPacket, encodeDisableChannel, encodeGetChannel, encodeSetChannel, Port } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { asBytes, asUint, fields, PbWriter } from '../src/lib/protocol/protobuf'
import type { Channel } from '../src/lib/model/types'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

const K16 = Uint8Array.from({ length: 16 }, (_, i) => i + 1)
const K32 = Uint8Array.from({ length: 32 }, (_, i) => i + 1)

describe('channel keys', () => {
  it('parses hex and base64 of an allowed length', () => {
    expect(parseKey(toHex(K16), [16])).toEqual(K16)
    expect(parseKey(` ${toBase64(K32)} `, [16, 32])).toEqual(K32)
    expect(parseKey(toBase64(K32).replace(/\+/g, '-').replace(/\//g, '_'), [32])).toEqual(K32)
    expect(parseKey(toBase64(K32), [16])).toBeUndefined()
    expect(parseKey('not a key', [16])).toBeUndefined()
  })

  it('a different channel: Meshtastic name or key, MeshCore key only', () => {
    const old = { index: 1, name: 'a', key: K16 }
    expect(channelReplaced('meshtastic', old, { ...old, name: 'b' })).toBe(true)
    expect(channelReplaced('meshcore', old, { ...old, name: 'b' })).toBe(false)
    expect(channelReplaced('meshcore', old, { ...old, key: K32.subarray(1, 17) })).toBe(true)
    expect(channelReplaced('meshtastic', old, { ...old })).toBe(false)
    expect(channelReplaced('meshcore', undefined, old)).toBe(true)
  })
})

/** ChannelSettings fields of a set_channel AdminMessage. */
function settingsOf(admin: Uint8Array) {
  const ch = asBytes([...fields(admin)].find((f) => f.no === Admin.SET_CHANNEL)!.value)
  const parts = [...fields(ch)]
  const s = asBytes(parts.find((f) => f.no === 2)!.value)
  return { index: asUint(parts.find((f) => f.no === 1)!.value), role: asUint(parts.find((f) => f.no === 3)!.value), s: [...fields(s)] }
}

describe('Meshtastic set_channel', () => {
  it('new channel: name, key, MQTT off, exact position', () => {
    const { index, role, s } = settingsOf(encodeSetChannel(3, 2, 'Pals', K32))
    expect([index, role]).toEqual([3, 2])
    expect(s.map((f) => f.no).sort()).toEqual([2, 3, 7])
    const module = [...fields(asBytes(s.find((f) => f.no === 7)!.value))]
    expect(module).toEqual([{ no: 1, type: 0, value: 32 }])
  })

  it('edit keeps the other settings', () => {
    const old = new PbWriter().uint(1, 0).bytes(2, K16).string(3, 'Old').fixed32(4, 0xdeadbeef).bool(5, true).bool(6, true)
      .message(7, new PbWriter().uint(1, 13).bool(2, true)).finish()
    const { s } = settingsOf(encodeSetChannel(1, 2, 'New', Uint8Array.of(1), old))
    const by = new Map(s.map((f) => [f.no, f.value]))
    expect(by.get(3)).toEqual(new TextEncoder().encode('New'))
    expect(by.get(2)).toEqual(Uint8Array.of(1))
    expect(by.get(5)).toBe(1)
    expect(by.get(6)).toBe(1)
    expect([...fields(by.get(7) as Uint8Array)].map((f) => f.value)).toEqual([13, 1])
    expect(s.filter((f) => f.no === 2 || f.no === 3)).toHaveLength(2)
  })

  it('an empty key and name are left out', () => {
    expect(settingsOf(encodeSetChannel(0, 1, '', new Uint8Array())).s.map((f) => f.no)).toEqual([7])
  })

  it('disabling a slot: role DISABLED, empty settings', () => {
    expect(settingsOf(encodeDisableChannel(4))).toEqual({ index: 4, role: 0, s: [] })
  })

  it('get_channel_request takes index + 1', () => {
    expect([...encodeGetChannel(2)]).toEqual([0x08, 3])
  })
})

describe('MeshCore SET_CHANNEL', () => {
  it('[32][index][name 32][secret 16]', () => {
    const f = cmdSetChannel(5, '#test', K16)
    expect(f.length).toBe(50)
    expect([f[0], f[1]]).toEqual([Cmd.SET_CHANNEL, 5])
    expect(new LeReader(f.subarray(2)).cstr(32)).toBe('#test')
    expect(f.subarray(34)).toEqual(K16)
  })
})

/** FromRadio frame. */
const fromRadio = (no: number, body: Uint8Array) => encodeFrame(new PbWriter().bytes(no, body).finish())

describe('Meshtastic client setChannel', () => {
  function setup() {
    const stored = new Map<number, Uint8Array>()
    const channels: Channel[][] = []
    const t = {
      label: 'x',
      onData: (_: Uint8Array) => {},
      onClose: () => {},
      write: async (b: Uint8Array) => {
        const f = [...fields(b.subarray(4))].find((x) => x.no === 1)
        if (!f) return
        const p = decodeMeshPacket(asBytes(f.value))
        const replies: Uint8Array[] = [fromRadio(11, new PbWriter().uint(4, p.id).finish())]
        const admin = [...fields(p.decoded!.payload!)][0]
        if (admin.no === Admin.SET_CHANNEL) {
          const ch = asBytes(admin.value)
          stored.set(asUint([...fields(ch)].find((x) => x.no === 1)?.value ?? 0), ch)
        } else if (admin.no === Admin.GET_CHANNEL_REQUEST) {
          const data = new PbWriter().uint(1, Port.ADMIN).bytes(2, new PbWriter().bytes(2, stored.get(asUint(admin.value) - 1)!).finish()).fixed32(6, p.id)
          replies.push(fromRadio(2, new PbWriter().fixed32(1, 0).fixed32(2, 0).message(4, data).fixed32(6, 99).finish()))
        }
        setTimeout(() => replies.forEach((r) => t.onData(r)))
      },
    }
    const rec = recordingSink()
    rec.sink.channels = (l) => void channels.push(l)
    const client = new MeshtasticClient(t as unknown as Transport, rec.sink)
    return { client, t, channels }
  }

  it('writes a new secondary and reads it back', async () => {
    const { client, channels } = setup()
    await client.setChannel({ index: 2, name: 'Pals', key: K32 }, true)
    expect(client.channelConfig(2)).toEqual({ index: 2, name: 'Pals', key: K32 })
    expect(channels.at(-1)).toContainEqual(expect.objectContaining({ index: 2, name: 'Pals', kind: 'secondary', encryption: 'AES-256' }))
  })

  it('an edit keeps settings it does not change', async () => {
    const { client, t } = setup()
    const s = new PbWriter().bytes(2, K16).string(3, 'Old').bool(5, true).message(7, new PbWriter().uint(1, 13))
    t.onData(fromRadio(10, new PbWriter().uint(1, 1).message(2, s).uint(3, 2).finish()))
    await client.setChannel({ index: 1, name: 'Old', key: K32 }, false)
    expect(client.channelConfig(1)?.key).toEqual(K32)
    const kept = [...fields((client as unknown as { channelInfos: { settings: Uint8Array }[] }).channelInfos[1].settings)]
    expect(kept.find((f) => f.no === 5)?.value).toBe(1)
  })

  it('deletes a secondary by disabling it; not the primary', async () => {
    const { client, channels } = setup()
    await client.setChannel({ index: 2, name: 'Pals', key: K32 }, true)
    await client.deleteChannel(2)
    expect(client.channelConfig(2)).toBeUndefined()
    expect(channels.at(-1)?.some((c) => c.index === 2)).toBe(false)
    await expect(client.deleteChannel(0)).rejects.toThrow(/primary/)
  })
})

describe('MeshCore client channels', () => {
  function setup() {
    const slots = new Map<number, Uint8Array>()
    const channels: Channel[][] = []
    const t = {
      label: 'x',
      onData: (_: Uint8Array) => {},
      onClose: () => {},
      write: async (b: Uint8Array) => {
        const cmd = b.subarray(3)
        let reply: Uint8Array
        if (cmd[0] === Cmd.SET_CHANNEL) {
          slots.set(cmd[1], cmd.slice(2))
          reply = Uint8Array.of(Resp.OK)
        } else reply = Uint8Array.of(Resp.CHANNEL_INFO, cmd[1], ...(slots.get(cmd[1]) ?? new Uint8Array(48)))
        setTimeout(() => t.onData(mcIn(reply)))
      },
    }
    const rec = recordingSink()
    rec.sink.channels = (l) => void channels.push(l)
    return { client: new MeshCoreClient(t as unknown as Transport, rec.sink), slots, channels }
  }
  // sha256("#test")[:16]
  const key = Uint8Array.from('9cd8fcf22a47333b591d96a2b848b73f'.match(/../g)!, (h) => parseInt(h, 16))

  it('writes, reads back and lists the channel', async () => {
    const { client, channels } = setup()
    await client.setChannel({ index: 3, name: '#test', key }, true)
    expect(client.channelConfig(3)).toEqual({ index: 3, name: '#test', key })
    expect(channels.at(-1)).toEqual([{ index: 3, name: '#test', kind: 'hashtag', encryption: 'hashtag key' }])
  })

  it('deletes with an empty name and zero key, Public included', async () => {
    const { client, slots, channels } = setup()
    await client.setChannel({ index: 0, name: 'Public', key: K16 }, true)
    await client.setChannel({ index: 3, name: '#test', key }, true)
    await client.deleteChannel(0)
    expect(slots.get(0)).toEqual(new Uint8Array(48))
    expect(client.channelConfig(0)).toBeUndefined()
    expect(channels.at(-1)?.map((c) => c.index)).toEqual([3])
  })
})
