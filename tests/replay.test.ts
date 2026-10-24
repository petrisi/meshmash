// Replays captured radio→host sessions through the protocol clients. Captures contain real
// node data, so they are not in the repo and only structural invariants are asserted.
// Run with MESHMASH_CAPTURES=<dir with mt-*.bin (Meshtastic) and mc-*.bin (MeshCore) captures>.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { concat } from '../src/lib/protocol/bytes'
import { detectProtocol, PROBE_NONCE } from '../src/lib/protocol/detect'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import { Cmd, decodeChannelInfo, decodeContact, FrameDecoder as McDecoder, Resp } from '../src/lib/protocol/meshcore/codec'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { decodeFromRadio } from '../src/lib/protocol/meshtastic/codec'
import { encodeFrame, FrameDecoder } from '../src/lib/protocol/meshtastic/framing'
import { fields, PbWriter } from '../src/lib/protocol/protobuf'
import type { SerialTransport } from '../src/lib/transport/serial'
import { CAPTURES, capture, captureNames, mcIn, recordingSink, type Recorded } from './helpers'

const MESHTASTIC = captureNames('mt-')
const MESHCORE = captureNames('mc-')

const title = (name: string, data: Uint8Array | undefined) =>
  data ? name : `${name} (skipped: ${CAPTURES ? 'not found in MESHMASH_CAPTURES' : 'set MESHMASH_CAPTURES to a capture directory'})`

const mtFrames = (data: Uint8Array) => new FrameDecoder().push(data).flatMap((i) => (i.type === 'frame' ? [i.payload] : []))

/**
 * Fake port that answers the first want_config with the captured stream, its
 * config_complete_id rewritten to the requested nonce, in `chunk`-byte pieces.
 */
function meshtasticPort(frames: Uint8Array[], chunk = 61) {
  let fed = false
  const t = {
    label: 'replay',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    async write(b: Uint8Array) {
      if (fed || b[0] !== 0x94) return
      let nonce: number | undefined
      for (const f of fields(b.subarray(4))) if (f.no === 3) nonce = f.value as number
      if (nonce === undefined) return
      fed = true
      const stream = concat(
        ...frames.map((f) => encodeFrame(decodeFromRadio(f).kind === 'config_complete_id' ? new PbWriter().uint(7, nonce!).finish() : f)),
      )
      setTimeout(() => {
        for (let i = 0; i < stream.length; i += chunk) t.onData(stream.subarray(i, i + chunk))
      }, 1)
    },
  }
  return t as unknown as SerialTransport
}

function checkMeshtastic(rec: Recorded) {
  expect(rec.errors()).toEqual([])
  expect(rec.info).toHaveLength(1)
  const info = rec.info[0]
  expect(info.protocol).toBe('meshtastic')
  expect(info.nodeId).toMatch(/^![0-9a-f]{8}$/)
  expect(info.radio.preset).toBeTruthy()
  expect(rec.nodes.size).toBeGreaterThan(0)
  expect(rec.nodes.has(info.nodeId)).toBe(true)
  for (const [id, n] of rec.nodes) {
    expect(id).toMatch(/^![0-9a-f]{8}$/)
    expect(typeof n.longName).toBe('string')
  }
  const channels = rec.channels.at(-1)!
  expect(channels.length).toBeGreaterThan(0)
  expect(channels.filter((c) => c.kind === 'primary')).toHaveLength(1)
  for (const c of channels) expect(c.name).toBeTruthy()
  const kinds = new Set(rec.logs.map((l) => l.kind))
  for (const k of ['FromRadio.my_info', 'FromRadio.node_info', 'FromRadio.config', 'FromRadio.channel', 'FromRadio.config_complete_id'])
    expect(kinds).toContain(k)
}

describe('Meshtastic replay', () => {
  for (const name of MESHTASTIC) {
    const data = capture(name)
    describe.skipIf(!data)(title(name, data), () => {
      afterEach(() => vi.useRealTimers())

      it('every frame decodes', () => {
        const frames = mtFrames(data!)
        expect(frames.length).toBeGreaterThan(0)
        for (const f of frames) expect(() => decodeFromRadio(f)).not.toThrow()
        expect(frames.map((f) => decodeFromRadio(f).kind)).toContain('config_complete_id')
      })

      it('completes the config download', async () => {
        const rec = recordingSink()
        const client = new MeshtasticClient(meshtasticPort(mtFrames(data!)), rec.sink)
        await client.start()
        await rec.ready
        await client.close()
        checkMeshtastic(rec)
      })

      it('continues from the detection probe', async () => {
        vi.useFakeTimers()
        const t = meshtasticPort(mtFrames(data!))
        const rec = recordingSink()
        const detected = detectProtocol(t, rec.sink)
        await vi.advanceTimersByTimeAsync(2000)
        const { protocol, probe } = await detected
        expect(protocol).toBe('meshtastic')
        expect(probe.nonce).toBe(PROBE_NONCE)
        const client = new MeshtasticClient(t, rec.sink)
        await client.start(probe)
        await client.close()
        checkMeshtastic(rec)
        // Console lines detection logged are not logged twice.
        const text = rec.logs.filter((l) => l.dir === 'text').map((l) => l.summary)
        expect(new Set(text).size).toBe(text.length)
      })
    })
  }
})

/** Fake port answering each command with the captured response frames for it. */
function meshcorePort(data: Uint8Array) {
  const frames = new McDecoder().push(data).flatMap((i) => (i.type === 'frame' ? [i.payload] : []))
  const byCode = (c: number) => frames.filter((f) => f[0] === c)
  const responses = new Map<number, Uint8Array[]>([
    [Cmd.DEVICE_QUERY, byCode(Resp.DEVICE_INFO)],
    [Cmd.APP_START, byCode(Resp.SELF_INFO)],
    [Cmd.GET_BATT_AND_STORAGE, byCode(Resp.BATT_AND_STORAGE)],
    [Cmd.GET_DEVICE_TIME, byCode(Resp.CURR_TIME)],
    [Cmd.GET_CONTACTS, [...byCode(Resp.CONTACTS_START), ...byCode(Resp.CONTACT), ...byCode(Resp.END_OF_CONTACTS)]],
    [Cmd.SYNC_NEXT_MESSAGE, [Uint8Array.of(Resp.NO_MORE_MESSAGES)]],
  ])
  const channels = byCode(Resp.CHANNEL_INFO)
  const commands: number[] = []
  const t = {
    label: 'replay',
    onData: (_: Uint8Array) => {},
    onClose: () => {},
    async write(b: Uint8Array) {
      expect(b[0]).toBe(0x3c)
      const cmd = b.subarray(3)
      commands.push(cmd[0])
      let reply = responses.get(cmd[0])
      if (cmd[0] === Cmd.GET_CHANNEL) {
        const empty = new Uint8Array(50)
        empty[0] = Resp.CHANNEL_INFO
        empty[1] = cmd[1]
        reply = [channels.find((c) => c[1] === cmd[1]) ?? empty]
      }
      reply ??= [Uint8Array.of(Resp.ERR, 1)]
      setTimeout(() => t.onData(concat(...reply.map(mcIn))), 1)
    },
  }
  return { t: t as unknown as SerialTransport, frames, byCode, commands }
}

describe('MeshCore replay', () => {
  for (const name of MESHCORE) {
    const data = capture(name)
    describe.skipIf(!data)(title(name, data), () => {
      it('every contact and channel frame decodes', () => {
        const { frames, byCode } = meshcorePort(data!)
        expect(frames.length).toBeGreaterThan(0)
        expect(byCode(Resp.DEVICE_INFO).length).toBeGreaterThan(0)
        expect(byCode(Resp.CONTACT).length).toBeGreaterThan(0)
        for (const f of byCode(Resp.CONTACT)) {
          const c = decodeContact(f)
          expect(c.publicKey).toHaveLength(32)
          expect(c.type).toBeLessThanOrEqual(4)
        }
        for (const f of byCode(Resp.CHANNEL_INFO)) expect(decodeChannelInfo(f).secret).toHaveLength(16)
      })

      it('completes the handshake and initial download', async () => {
        const { t, byCode, commands } = meshcorePort(data!)
        const rec = recordingSink()
        const client = new MeshCoreClient(t, rec.sink)
        await client.start()
        await rec.ready
        // Let the post-ready message sync finish.
        await new Promise((r) => setTimeout(r, 50))
        await client.close()

        expect(rec.errors()).toEqual([])
        expect(commands.slice(0, 2)).toEqual([Cmd.DEVICE_QUERY, Cmd.APP_START])
        expect(commands).toContain(Cmd.GET_CONTACTS)
        expect(commands).toContain(Cmd.SYNC_NEXT_MESSAGE)
        expect(rec.info).toHaveLength(1)
        const info = rec.info[0]
        expect(info.protocol).toBe('meshcore')
        expect(info.longName).toBeTruthy()
        expect(info.radio.freqMHz).toBeGreaterThan(100)
        // Self plus contacts (keyed by public key prefix).
        const contacts = new Set(byCode(Resp.CONTACT).map((f) => decodeContact(f).publicKey.join()))
        expect(rec.nodes.size).toBe(contacts.size + 1)
        for (const n of rec.nodes.values()) expect(['chat', 'repeater', 'room', 'sensor']).toContain(n.kind)
        const channels = rec.channels.at(-1)!
        expect(channels.length).toBeGreaterThan(0)
        for (const c of channels) expect(c.name).toBeTruthy()
        expect(new Set(channels.map((c) => c.index)).size).toBe(channels.length)
      })
    })
  }
})
