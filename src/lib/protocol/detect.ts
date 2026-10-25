import type { Protocol } from '../model/types'
import type { Transport } from '../transport/types'
import { cmdDeviceQuery, encodeFrame as mcFrame, FrameDecoder as McDecoder, Resp } from './meshcore/codec'
import { decodeFromRadio, toRadioWantConfig } from './meshtastic/codec'
import { encodeFrame as mtFrame, FrameDecoder as MtDecoder, WAKE } from './meshtastic/framing'
import type { Probe, RadioSink } from './types'

/** Meshtastic console log line, e.g. "DEBUG | 21:25:51 3301 ...". */
const MT_LOG_LINE = /^(TRACE|DEBUG|INFO|WARN|ERROR|CRIT)\s*\|/

/** Encodes without a 0x3C byte. */
export const PROBE_NONCE = 0x1234567

/**
 * Identifies the firmware on the other end of the port.
 *
 * MeshCore is probed first: its query is ignored by Meshtastic. The Meshtastic probe is a
 * config request whose bytes avoid '<', so it cannot start a MeshCore frame. Opening a
 * port can reset ESP32 boards, so probes are repeated while the radio boots.
 *
 * Meshtastic on TinyUSB boards (e.g. Seeed XIAO S3, USB 2886:0059) polls serial input only
 * every 20 s, so the overall wait has to cover that. Its console log lines identify it early.
 */
export async function detectProtocol(
  t: Transport,
  sink: RadioSink,
  timeoutMs = 25_000,
): Promise<{ protocol: Protocol; probe: Probe }> {
  const received: Uint8Array[] = []
  const mt = new MtDecoder()
  const mc = new McDecoder()
  let found: Protocol | null = null
  let wake: () => void = () => {}
  let seenConsole = false

  t.onData = (chunk) => {
    received.push(chunk)
    for (const item of mc.push(chunk)) {
      if (item.type === 'frame' && item.payload[0] === Resp.DEVICE_INFO) found ??= 'meshcore'
    }
    for (const item of mt.push(chunk)) {
      if (item.type === 'text') {
        sink.log({ dir: 'text', kind: 'console', summary: item.text })
        if (!seenConsole && MT_LOG_LINE.test(item.text)) {
          seenConsole = true
          sink.progress('Meshtastic radio found, waiting for it to answer…')
        }
        continue
      }
      try {
        const m = decodeFromRadio(item.payload)
        if (m.kind !== 'other') found ??= 'meshtastic'
      } catch {
        /* not a FromRadio */
      }
    }
    if (found) wake()
  }

  const waitFor = (ms: number) =>
    new Promise<void>((resolve) => {
      if (found) return resolve()
      const timer = setTimeout(resolve, ms)
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  const deadline = Date.now() + timeoutMs
  for (let i = 0; Date.now() < deadline && !found; i++) {
    if (!seenConsole) sink.progress(i ? `Waiting for radio (attempt ${i + 1})…` : 'Detecting protocol…')
    const q = cmdDeviceQuery()
    sink.log({ dir: 'tx', kind: 'probe MeshCore', summary: 'CMD_DEVICE_QUERY', bytes: q })
    await t.write(mcFrame(q))
    await waitFor(1200)
    if (found) break
    const wc = toRadioWantConfig(PROBE_NONCE)
    sink.log({ dir: 'tx', kind: 'probe Meshtastic', summary: 'wake + want_config_id', bytes: wc })
    await t.write(WAKE)
    await t.write(mtFrame(wc))
    await waitFor(1800)
  }
  // Keep buffering until the client takes over the port.
  const textLogged = received.length
  t.onData = (chunk) => received.push(chunk)
  if (!found) throw new Error('No Meshtastic or MeshCore radio answered on this port')
  sink.log({ dir: 'info', kind: 'detect', summary: `protocol: ${found}` })
  return { protocol: found, probe: { nonce: PROBE_NONCE, received, textLogged } }
}
