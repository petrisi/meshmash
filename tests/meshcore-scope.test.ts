// MeshCore flood scopes: region keys and transport codes, scoped channel sends, and the scope
// of packets heard.
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { byScope, type PacketRecord } from '../src/lib/model/analytics'
import { scopeKey, scopeName, transportCode } from '../src/lib/model/scope'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Cmd, cmdSetFloodScope, decodeDefaultFloodScope, Push, Resp, splitPacket } from '../src/lib/protocol/meshcore/codec'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

/** The firmware's computation, written independently with node:crypto. */
const refKey = (name: string) => createHash('sha256').update(`#${name}`).digest().subarray(0, 16)
function refCode(key: Uint8Array, type: number, payload: Uint8Array) {
  const mac = createHmac('sha256', key).update(Uint8Array.of(type, ...payload)).digest()
  const code = mac[0] | (mac[1] << 8)
  return code === 0 ? 1 : code === 0xffff ? 0xfffe : code
}

describe('scope names', () => {
  it('accepts what the firmware accepts; drops a leading #', () => {
    expect(scopeName('fi')).toBe('fi')
    expect(scopeName(' #Tampere-1 ')).toBe('Tampere-1')
    expect(scopeName('Ähtäri')).toBe('Ähtäri')
    expect(scopeName('a_b')).toBe('a_b')
  })
  it('rejects private, punctuation, empty and too long names', () => {
    for (const t of ['', '#', '$fi', 'a b', 'a.b', 'a/b', 'x'.repeat(31), 'ä'.repeat(16)]) expect(scopeName(t)).toBeNull()
    expect(scopeName('x'.repeat(30))).toBe('x'.repeat(30))
  })
})

describe('keys and codes', () => {
  it('match the firmware computation', async () => {
    expect(await scopeKey('fi')).toEqual(new Uint8Array(refKey('fi')))
    const payload = Uint8Array.from({ length: 40 }, (_, i) => i * 7)
    const key = await scopeKey('fi')
    expect(await transportCode(key, 5, payload)).toBe(refCode(refKey('fi'), 5, payload))
  })
  it('splitPacket reads transport codes for route types 0 and 3 only', () => {
    expect(splitPacket(Uint8Array.of((5 << 2) | 0, 0x34, 0x12, 0, 0, 0, 9))?.codes).toEqual([0x1234, 0])
    expect(splitPacket(Uint8Array.of((5 << 2) | 1, 0, 9))?.codes).toBeUndefined()
  })
  it('scope commands and the default scope response', () => {
    const k = new Uint8Array(16).fill(7)
    expect([...cmdSetFloodScope(k)]).toEqual([Cmd.SET_FLOOD_SCOPE_KEY, 0, ...k])
    expect([...cmdSetFloodScope(null)]).toEqual([Cmd.SET_FLOOD_SCOPE_KEY, 0])
    expect([...cmdSetFloodScope('none')]).toEqual([Cmd.SET_FLOOD_SCOPE_KEY, 1])
    const name = new Uint8Array(31)
    name.set(new TextEncoder().encode('fi'))
    expect(decodeDefaultFloodScope(Uint8Array.of(Resp.DEFAULT_FLOOD_SCOPE, ...name, ...k))).toEqual({ name: 'fi', key: k })
    expect(decodeDefaultFloodScope(Uint8Array.of(Resp.DEFAULT_FLOOD_SCOPE))).toBeNull()
  })
})

function setup() {
  const sent: Uint8Array[] = []
  const client: { c?: MeshCoreClient } = {}
  let onWrite: (cmd: Uint8Array) => void = () => {}
  const t = {
    label: 'x',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    write: async (b: Uint8Array) => {
      const cmd = b.slice(3)
      sent.push(cmd)
      onWrite(cmd)
      setTimeout(() => t.onData(mcIn(Uint8Array.of(Resp.OK))), 2)
    },
  }
  const rec = recordingSink()
  const records: PacketRecord[] = []
  rec.sink.packet = (r) => void records.push(r)
  client.c = new MeshCoreClient(t as unknown as Transport, rec.sink)
  return { client: client.c, sent, records, t, setOnWrite: (f: (cmd: Uint8Array) => void) => (onWrite = f) }
}

describe('scoped channel send', () => {
  it('sets the scope, sends, clears it, with no other command in between', async () => {
    const { client, sent, setOnWrite } = setup()
    let other: Promise<void> | undefined
    setOnWrite((cmd) => {
      if (cmd[0] === Cmd.SET_FLOOD_SCOPE_KEY && cmd.length > 2 && !other) other = client.action('advert-zero', 'x')
    })
    await client.sendText('ch:1', 'hi', 'l1', { scope: 'fi' })
    await other
    expect(sent.map((c) => [...c.subarray(0, 2)])).toEqual([
      [Cmd.SET_FLOOD_SCOPE_KEY, 0],
      [Cmd.SEND_CHANNEL_TXT_MSG, 0],
      [Cmd.SET_FLOOD_SCOPE_KEY, 0],
      [Cmd.SEND_SELF_ADVERT, 0],
    ])
    expect(sent[0].subarray(2)).toEqual(new Uint8Array(refKey('fi')))
    expect(sent[2].length).toBe(2)
  })

  it('unscoped uses the unscoped command; the radio default sends no scope command', async () => {
    const a = setup()
    await a.client.sendText('ch:1', 'hi', 'l1', { scope: null })
    expect(a.sent.map((c) => [...c.subarray(0, 2)])).toEqual([[Cmd.SET_FLOOD_SCOPE_KEY, 1], [Cmd.SEND_CHANNEL_TXT_MSG, 0], [Cmd.SET_FLOOD_SCOPE_KEY, 0]])
    const b = setup()
    await b.client.sendText('ch:1', 'hi', 'l1')
    expect(b.sent.map((c) => c[0])).toEqual([Cmd.SEND_CHANNEL_TXT_MSG])
  })
})

describe('scope of packets heard', () => {
  const payload = Uint8Array.from({ length: 20 }, (_, i) => 0x40 + i)
  /** A TXT_MSG (type 2) flood: transport flood with the given code, or plain flood. */
  const packet = (code?: number) =>
    code === undefined
      ? Uint8Array.of((2 << 2) | 1, 0, ...payload)
      : Uint8Array.of((2 << 2) | 0, code & 0xff, code >> 8, 0, 0, 0, ...payload)
  const hear = (t: { onData: (b: Uint8Array) => void }, raw: Uint8Array) =>
    t.onData(mcIn(Uint8Array.of(Push.LOG_RX_DATA, 20, 0xa6, ...raw)))
  const settle = () => new Promise((r) => setTimeout(r, 50))

  it('names a known region, marks others and unscoped', async () => {
    const { client, t, records } = setup()
    client.setKnownScopes(['fi', 'se'])
    hear(t, packet(refCode(refKey('fi'), 2, payload)))
    hear(t, packet(refCode(refKey('no'), 2, payload)))
    hear(t, packet())
    await settle()
    expect(records.map((r) => r.scope).sort()).toEqual(['', 'fi', null])
  })
})

describe('byScope', () => {
  it('counts received packets by scope; older records without it apart', () => {
    const r = (scope: string | null | undefined, ts = 100, dir: 'rx' | 'tx' = 'rx'): PacketRecord => ({ ts, dir, type: 'dm', scope })
    const out = byScope([r('fi'), r('fi', 120), r(null), r(''), r(undefined), r('fi', 5), r('fi', 110, 'tx')], { types: null, repeats: false }, 50)
    expect(out.received).toBe(5)
    expect(out.unrecorded).toBe(1)
    expect(out.rows).toEqual([
      { scope: 'fi', count: 2, last: 120 },
      { scope: null, count: 1, last: 100 },
      { scope: '', count: 1, last: 100 },
    ])
  })
})
