// Replays a captured Meshtastic serial session (raw radio→host bytes after want_config)
// through MeshtasticClient without hardware.
// Build: npx vite build --ssr scripts/replay-meshtastic.ts --outDir <dir>; run: node <dir>/replay-meshtastic.js <capture.bin>
import { readFileSync } from 'node:fs'
import { decodeFromRadio } from '../src/lib/protocol/meshtastic/codec'
import { PbWriter } from '../src/lib/protocol/protobuf'
import { encodeFrame, FrameDecoder } from '../src/lib/protocol/meshtastic/framing'
import { MeshtasticClient } from '../src/lib/protocol/meshtastic/client'
import { fields } from '../src/lib/protocol/protobuf'
import type { RadioSink } from '../src/lib/protocol/types'
import type { SerialTransport } from '../src/lib/transport/serial'

const items = new FrameDecoder().push(readFileSync(process.argv[2]))
const frames = items.flatMap((i) => (i.type === 'frame' ? [i.payload] : []))
const textLines = items.filter((i) => i.type === 'text').length

let fed = false
const fake = {
  label: 'replay',
  onData: (_: Uint8Array) => {},
  onClose: () => {},
  async write(b: Uint8Array) {
    // Only the ToRadio want_config (field 3) triggers the captured stream.
    if (fed || b[0] !== 0x94) return
    const toRadio = b.subarray(4)
    let nonce: number | undefined
    for (const f of fields(toRadio)) if (f.no === 3) nonce = f.value as number
    if (nonce === undefined) return
    fed = true
    setTimeout(() => {
      for (const f of frames) {
        const m = decodeFromRadio(f)
        const out = m.kind === 'config_complete_id' ? new PbWriter().uint(7, nonce!).finish() : f
        fake.onData(encodeFrame(out))
      }
    }, 1)
  },
} as unknown as SerialTransport

const kinds: Record<string, number> = {}
const nodes = new Map<string, Record<string, unknown>>()
const sink: RadioSink = {
  info: (info, caps) => console.log('INFO', JSON.stringify(info), JSON.stringify(caps)),
  progress: () => {},
  node: (p) => nodes.set(p.id, { ...nodes.get(p.id), ...p }),
  removeNode: () => {},
  channels: (l) => console.log('CHANNELS', JSON.stringify(l)),
  message: (m) => console.log('MSG', JSON.stringify(m)),
  updateMessage: () => {},
  heard: () => {},
  traceroute: (r) => console.log('TRACE', JSON.stringify(r)),
  actionResult: (id, action, ok, text) => console.log('RESULT', id, action, ok, text),
  remote: (id, p) => console.log('REMOTE', id, JSON.stringify(p)),
  cliLine: (id, dir, text) => console.log('CLI', id, dir, text),
  log: (e) => {
    kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    if (e.dir === 'error') console.log('ERROR', e.kind, e.summary)
    if (e.kind === 'FromRadio.packet') console.log('PACKET', e.summary)
  },
  ready: () => {
    console.log('READY nodes', nodes.size, 'text lines', textLines)
    const list = [...nodes.values()]
    for (const n of list.slice(0, 6)) console.log('  NODE', JSON.stringify({ ...n, publicKey: undefined }))
    const roles: Record<string, number> = {}
    for (const n of list) roles[String(n.role)] = (roles[String(n.role)] ?? 0) + 1
    console.log('ROLES', JSON.stringify(roles))
    console.log('WITH POSITION', list.filter((n) => n.position).length, 'MQTT', list.filter((n) => n.viaMqtt).length)
    console.log('FRAME KINDS', JSON.stringify(kinds))
  },
  closed: () => {},
}

new MeshtasticClient(fake, sink).start().then(
  () => console.log('start() resolved'),
  (e) => console.log('start() failed', e),
)
setTimeout(() => {
  const list = [...nodes.values()]
  console.log('AFTER REPLAY: with position', list.filter((n) => n.position).length, 'with hops', list.filter((n) => n.hops !== undefined).length, 'of', list.length)
  process.exit(0)
}, 3000)
