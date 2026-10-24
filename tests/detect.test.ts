import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { concat, LeWriter, utf8Encode } from '../src/lib/protocol/bytes'
import { detectProtocol, PROBE_NONCE } from '../src/lib/protocol/detect'
import { Cmd, Resp } from '../src/lib/protocol/meshcore/codec'
import { toRadioWantConfig } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame } from '../src/lib/protocol/meshtastic/framing'
import { fields, PbWriter } from '../src/lib/protocol/protobuf'
import type { SerialTransport } from '../src/lib/transport/serial'
import { mcIn, recordingSink } from './helpers'

/** Fake port: `answer` sees each write and returns bytes to deliver shortly after. */
function fakePort(answer: (written: Uint8Array, n: number) => Uint8Array | undefined) {
  const writes: Uint8Array[] = []
  const t = {
    label: 'fake',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    async write(b: Uint8Array) {
      writes.push(b)
      const reply = answer(b, writes.length)
      if (reply) setTimeout(() => t.onData(reply), 10)
    },
  }
  return { t: t as unknown as SerialTransport, writes }
}

const isMcQuery = (b: Uint8Array) => b[0] === 0x3c && b[3] === Cmd.DEVICE_QUERY
const wantConfigNonce = (b: Uint8Array) => {
  if (b[0] !== 0x94 || b[1] !== 0xc3) return undefined
  for (const f of fields(b.subarray(4))) if (f.no === 3) return f.value as number
}
const deviceInfo = new LeWriter().u8(Resp.DEVICE_INFO).u8(13).u8(100).u8(8).finish()
const myInfo = encodeFrame(new PbWriter().message(3, new PbWriter().uint(1, 0x1234)).finish())

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('detectProtocol', () => {
  it('Meshtastic probe bytes cannot start a MeshCore frame', () => {
    expect(encodeFrame(toRadioWantConfig(PROBE_NONCE)).includes(0x3c)).toBe(false)
  })

  it('detects MeshCore from DEVICE_INFO', async () => {
    const { t, writes } = fakePort((b) => (isMcQuery(b) ? mcIn(deviceInfo) : undefined))
    const rec = recordingSink()
    const p = detectProtocol(t, rec.sink)
    await vi.advanceTimersByTimeAsync(100)
    const r = await p
    expect(r.protocol).toBe('meshcore')
    expect(writes).toHaveLength(1)
    expect(concat(...r.probe.received)).toEqual(mcIn(deviceInfo))
    expect(rec.logs.some((l) => l.kind === 'detect' && l.summary === 'protocol: meshcore')).toBe(true)
  })

  it('detects Meshtastic from a FromRadio answer to want_config', async () => {
    let nonce: number | undefined
    const { t } = fakePort((b) => {
      nonce ??= wantConfigNonce(b)
      return nonce !== undefined ? myInfo : undefined
    })
    const p = detectProtocol(t, recordingSink().sink)
    await vi.advanceTimersByTimeAsync(1500)
    const r = await p
    expect(r.protocol).toBe('meshtastic')
    expect(nonce).toBe(PROBE_NONCE)
    expect(r.probe.nonce).toBe(PROBE_NONCE)
    expect(concat(...r.probe.received)).toEqual(myInfo)
  })

  it('keeps probing a slow radio and reports console log lines', async () => {
    let probes = 0
    const { t } = fakePort((b) => {
      if (wantConfigNonce(b) === undefined) return undefined
      // Boot log first; the API answers only on the third config request.
      return ++probes === 1 ? utf8Encode('\x1b[32mINFO  | 00:00:01 1 Booting\x1b[0m\r\n') : probes === 3 ? myInfo : undefined
    })
    const rec = recordingSink()
    const p = detectProtocol(t, rec.sink)
    await vi.advanceTimersByTimeAsync(10_000)
    const r = await p
    expect(r.protocol).toBe('meshtastic')
    expect(probes).toBe(3)
    expect(rec.progress).toContain('Meshtastic radio found, waiting for it to answer…')
    expect(rec.logs.some((l) => l.dir === 'text' && l.summary === 'INFO  | 00:00:01 1 Booting')).toBe(true)
    // Bytes keep buffering after detection for the client to replay.
    t.onData(Uint8Array.of(1, 2))
    expect(r.probe.received.at(-1)).toEqual(Uint8Array.of(1, 2))
    expect(r.probe.textLogged).toBe(r.probe.received.length - 1)
  })

  it('ignores non-FromRadio frames and MeshCore frames other than DEVICE_INFO', async () => {
    const { t } = fakePort((b) => (isMcQuery(b) ? mcIn(Uint8Array.of(Resp.ERR, 1)) : encodeFrame(new PbWriter().uint(99, 1).finish())))
    const p = detectProtocol(t, recordingSink().sink, 5000)
    const done = expect(p).rejects.toThrow(/No Meshtastic or MeshCore radio/)
    await vi.advanceTimersByTimeAsync(6000)
    await done
  })

  it('gives up after the timeout', async () => {
    const { t, writes } = fakePort(() => undefined)
    const p = detectProtocol(t, recordingSink().sink)
    const done = expect(p).rejects.toThrow(/No Meshtastic or MeshCore radio/)
    await vi.advanceTimersByTimeAsync(30_000)
    await done
    // MeshCore query, wake, want_config per attempt; ~3 s per attempt over 25 s.
    expect(writes.length).toBeGreaterThanOrEqual(3 * 8)
    expect(writes.length % 3).toBe(0)
  })
})
