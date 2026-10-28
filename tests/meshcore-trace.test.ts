// Trace path: hop list from a found or stored route, and the result legs.
import { describe, expect, it, vi } from 'vitest'
import { LeWriter } from '../src/lib/protocol/bytes'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { type Contact, ContactType, encodePath, Push, Resp } from '../src/lib/protocol/meshcore/codec'
import { cmdTracePath, RemoteCmd, traceHashes } from '../src/lib/protocol/meshcore/remote'
import type { TracerouteResult } from '../src/lib/model/types'
import type { Transport } from '../src/lib/transport/types'
import { mcIn, recordingSink } from './helpers'

const TARGET = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i)

describe('traceHashes', () => {
  it('lists out hops, the target, then back hops', () => {
    expect(traceHashes(['11', '22'], TARGET, ['33'])).toEqual({ hashes: Uint8Array.of(0x11, 0x22, 0xc0, 0x33), pathSz: 0, size: 1 })
  })
  it('asymmetric: heard directly, answers through a repeater', () => {
    expect(traceHashes([], TARGET, ['5a']).hashes).toEqual(Uint8Array.of(0xc0, 0x5a))
  })
  it('uses 2-byte hashes only when every hop has them', () => {
    expect(traceHashes(['1122'], TARGET, ['3344'])).toEqual({ hashes: Uint8Array.of(0x11, 0x22, 0xc0, 0xc1, 0x33, 0x44), pathSz: 1, size: 2 })
    expect(traceHashes(['112233'], TARGET, []).hashes).toEqual(Uint8Array.of(0x11, 0x22, 0xc0, 0xc1))
    expect(traceHashes(['1122'], TARGET, ['33']).size).toBe(1)
    expect(traceHashes([], TARGET, []).hashes).toEqual(Uint8Array.of(0xc0))
  })
  it('puts the hash size in the flags', () => {
    expect([...cmdTracePath(1, Uint8Array.of(0xaa, 0xbb), 1)]).toEqual([RemoteCmd.SEND_TRACE_PATH, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0xaa, 0xbb])
  })
})

describe('encodePath', () => {
  it('packs hop count and hash size', () => {
    expect(encodePath(['1122', '3344'])).toEqual({ outLen: 0x42, outBytes: Uint8Array.of(0x11, 0x22, 0x33, 0x44) })
    expect(encodePath([])).toEqual({ outLen: 0, outBytes: new Uint8Array() })
  })
})

/** A client with one contact; the fake radio answers a trace with the given SNRs. */
function setup(contact: Partial<Contact>, snrs: number[]) {
  const sent: Uint8Array[] = []
  const results: TracerouteResult[] = []
  const failures: string[] = []
  const t = {
    label: 'x',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    write: async (b: Uint8Array) => {
      const cmd = b.subarray(3)
      sent.push(cmd)
      const tag = cmd.subarray(1, 5)
      const n = cmd.length - 10
      setTimeout(() => {
        t.onData(mcIn(Uint8Array.of(Resp.SENT, 0, ...tag, 0, 0, 0, 0)))
        if (!snrs.length) return
        const w = new LeWriter().u8(Push.TRACE_DATA).u8(0).u8(n).u8(cmd[9]).bytes(tag).u32(0).bytes(cmd.subarray(10))
        for (const s of snrs) w.u8((s * 4) & 0xff)
        setTimeout(() => t.onData(mcIn(w.finish())), 5)
      })
    },
  }
  const rec = recordingSink()
  rec.sink.traceroute = (r) => void results.push(r)
  rec.sink.actionResult = (_id, _a, ok, text) => void (ok || failures.push(text ?? ''))
  const client = new MeshCoreClient(t as unknown as Transport, rec.sink)
  const c: Contact = {
    publicKey: TARGET,
    type: ContactType.REPEATER,
    flags: 0,
    outPathLen: 0xff,
    outPath: new Uint8Array(64),
    name: 'Target',
    lastAdvert: 0,
    lat: 0,
    lon: 0,
    lastMod: 0,
    ...contact,
  }
  const id = 'c0c1c2c3c4c5'
  ;(client as unknown as { contacts: Map<string, Contact> }).contacts.set(id, c)
  return { client, id, sent, results, failures }
}

describe('trace', () => {
  it('follows the found route, out and back as found', async () => {
    const { client, id, sent, results } = setup({}, [6, 2.5, 7])
    await client.action('trace', id, { route: { ts: 1000, out: [], back: ['5a'] } })
    expect([...sent[0].subarray(9)]).toEqual([0, 0xc0, 0x5a])
    expect(results[0]).toMatchObject({
      towards: ['', id],
      snrTowards: [6],
      back: [id, '5a', ''],
      snrBack: [2.5, 7],
      traced: { via: 'found', foundTs: 1000, hashBytes: 1 },
    })
  })

  it('without a found route, uses the stored path and its reverse', async () => {
    const { client, id, sent, results } = setup({ outPathLen: 0x42, outPath: Uint8Array.of(0x11, 0x22, 0x33, 0x44) }, [1, 2, 3, 4, 5, 6])
    await client.action('trace', id)
    expect([...sent[0].subarray(9)]).toEqual([1, 0x11, 0x22, 0x33, 0x44, 0xc0, 0xc1, 0x33, 0x44, 0x11, 0x22])
    expect(results[0]).toMatchObject({
      towards: ['', '1122', '3344', id],
      back: [id, '3344', '1122', ''],
      snrTowards: [1, 2, 3],
      snrBack: [4, 5, 6],
      traced: { via: 'stored', hashBytes: 2 },
    })
  })

  it('without any path, tries a direct neighbour and says so; rooms get a hint', async () => {
    vi.useFakeTimers()
    try {
      const { client, id, sent, failures } = setup({ type: ContactType.ROOM }, [])
      const done = client.action('trace', id)
      await vi.advanceTimersByTimeAsync(11_000)
      await done
      expect([...sent[0].subarray(9)]).toEqual([0, 0xc0])
      expect(failures).toEqual(['No answer as a direct neighbour (no stored or found path); rooms pass a trace on only with repeat on'])
    } finally {
      vi.useRealTimers()
    }
  })
})
