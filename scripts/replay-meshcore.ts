// Replays a captured MeshCore session through MeshCoreClient without hardware.
// Capture: raw radio→host bytes of DEVICE_QUERY, APP_START, GET_BATT, GET_TIME,
// GET_CONTACTS and GET_CHANNEL commands.
// Build: npx vite build --ssr scripts/replay-meshcore.ts --outDir <dir>; run: node <dir>/replay-meshcore.js <capture.bin>
import { readFileSync } from 'node:fs'
import { Cmd, encodeFrame, FrameDecoder, Resp } from '../src/lib/protocol/meshcore/codec'
import { MeshCoreClient } from '../src/lib/protocol/meshcore/client'
import type { RadioSink } from '../src/lib/protocol/types'
import type { SerialTransport } from '../src/lib/transport/serial'

const capture = readFileSync(process.argv[2])
const frames = new FrameDecoder().push(capture).flatMap((i) => (i.type === 'frame' ? [i.payload] : []))

// Group captured responses by the command that produced them.
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

const toRadio: Uint8Array[] = []
const fake = {
  label: 'replay',
  onData: (_: Uint8Array) => {},
  onClose: () => {},
  async write(b: Uint8Array) {
    const cmd = b.subarray(3)
    toRadio.push(cmd)
    let reply = responses.get(cmd[0])
    if (cmd[0] === Cmd.GET_CHANNEL) {
      const idx = cmd[1]
      const empty = new Uint8Array(50)
      empty[0] = Resp.CHANNEL_INFO
      empty[1] = idx
      reply = [channels.find((c) => c[1] === idx) ?? empty]
    }
    if (!reply) reply = [Uint8Array.of(Resp.ERR, 1)]
    setTimeout(() => {
      for (const f of reply) fake.onData(encodeFrame(f).map((x, i) => (i === 0 ? 0x3e : x)))
    }, 1)
  },
} as unknown as SerialTransport

const counts: Record<string, number> = {}
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1)
const nodes = new Map<string, Record<string, unknown>>()
const sink: RadioSink = {
  info: (info, caps) => console.log('INFO', JSON.stringify(info), JSON.stringify(caps)),
  progress: (t) => bump(`progress:${t.replace(/\d+/g, 'N')}`),
  node: (p) => nodes.set(p.id, { ...nodes.get(p.id), ...p }),
  removeNode: () => bump('removeNode'),
  channels: (l) => console.log('CHANNELS', l.map((c) => `${c.index}:${c.name}(${c.kind})`).join(' ')),
  message: (m) => console.log('MSG', JSON.stringify(m)),
  updateMessage: () => bump('updateMessage'),
  heard: () => bump('heard'),
  traceroute: (r) => console.log('TRACE', JSON.stringify(r)),
  actionResult: (id, action, ok, text) => console.log('RESULT', id, action, ok, text),
  log: (e) => {
    bump(`log:${e.dir}`)
    if (e.dir === 'error' || e.dir === 'info') console.log('LOG', e.dir, e.kind, e.summary)
  },
  ready: () => {
    console.log('READY nodes', nodes.size)
    const sample = [...nodes.values()].slice(0, 5)
    for (const n of sample) console.log('  NODE', JSON.stringify({ ...n, publicKey: undefined }))
    const kinds: Record<string, number> = {}
    for (const n of nodes.values()) kinds[n.kind as string] = (kinds[n.kind as string] ?? 0) + 1
    console.log('KINDS', JSON.stringify(kinds))
    console.log('COMMANDS', toRadio.length, 'COUNTS', JSON.stringify(counts))
  },
  closed: (r) => console.log('CLOSED', r),
}

const client = new MeshCoreClient(fake, sink)
client.start().then(
  () => console.log('start() resolved'),
  (e) => console.log('start() failed', e),
)
