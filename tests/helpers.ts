// Shared test helpers: a recording RadioSink and capture lookup.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Channel, MeshNode, RadioInfo } from '../src/lib/model/types'
import { encodeFrame as mcFrame } from '../src/lib/protocol/meshcore/codec'
import type { LogEntry, RadioSink } from '../src/lib/protocol/types'

export interface Recorded {
  sink: RadioSink
  info: RadioInfo[]
  nodes: Map<string, Partial<MeshNode>>
  channels: Channel[][]
  logs: Omit<LogEntry, 'ts'>[]
  progress: string[]
  errors: () => Omit<LogEntry, 'ts'>[]
  ready: Promise<void>
}

export function recordingSink(): Recorded {
  let onReady: () => void = () => {}
  const r: Recorded = {
    info: [],
    nodes: new Map(),
    channels: [],
    logs: [],
    progress: [],
    errors: () => r.logs.filter((l) => l.dir === 'error'),
    ready: new Promise<void>((res) => (onReady = res)),
    sink: {
      info: (i) => void r.info.push(i),
      progress: (t) => void r.progress.push(t),
      node: (p) => void r.nodes.set(p.id, { ...r.nodes.get(p.id), ...p }),
      removeNode: (id) => void r.nodes.delete(id),
      channels: (l) => void r.channels.push(l),
      message: () => {},
      updateMessage: () => {},
      heard: () => {},
      traceroute: () => {},
      remote: () => {},
      cliLine: () => {},
      actionResult: () => {},
      log: (e) => void r.logs.push(e),
      ready: () => onReady(),
      closed: () => {},
    },
  }
  return r
}

/** IEEE-754 single bits, for writing protobuf float fields with PbWriter.fixed32. */
export function f32(v: number): number {
  const dv = new DataView(new ArrayBuffer(4))
  dv.setFloat32(0, v, true)
  return dv.getUint32(0, true)
}

export const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill)

/** Directory of captured sessions, from MESHMASH_CAPTURES; undefined when unset. */
export const CAPTURES = process.env.MESHMASH_CAPTURES

/** Capture file names with a prefix (`mt-` Meshtastic, `mc-` MeshCore), or one placeholder
 * name so the skipped test still shows up when no captures are available. */
export function captureNames(prefix: string): string[] {
  const names = CAPTURES && existsSync(CAPTURES) ? readdirSync(CAPTURES).filter((n) => n.startsWith(prefix) && n.endsWith('.bin')) : []
  return names.length ? names.sort() : [`${prefix}*.bin`]
}

export function capture(name: string): Uint8Array | undefined {
  if (!CAPTURES) return undefined
  const p = join(CAPTURES, name)
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
}

/** Radio→host MeshCore frame ('>' instead of '<'). */
export const mcIn = (p: Uint8Array) => {
  const f = mcFrame(p)
  f[0] = 0x3e
  return f
}
