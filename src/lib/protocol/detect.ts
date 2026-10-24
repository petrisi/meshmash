import type { Protocol } from '../model/types'
import type { SerialTransport } from '../transport/serial'
import { cmdDeviceQuery, encodeFrame as mcFrame, FrameDecoder as McDecoder, Resp } from './meshcore/codec'
import { decodeFromRadio, toRadioWantConfig } from './meshtastic/codec'
import { encodeFrame as mtFrame, FrameDecoder as MtDecoder, WAKE } from './meshtastic/framing'
import type { RadioSink } from './types'

/** Encodes without a 0x3C byte. */
const PROBE_NONCE = 0x1234567

/**
 * Identifies the firmware on the other end of the port.
 *
 * MeshCore is probed first: its query is ignored by Meshtastic. The Meshtastic probe is a
 * config request whose bytes avoid '<', so it cannot start a MeshCore frame. Opening a
 * port can reset ESP32 boards, so probes are repeated while the radio boots.
 */
export async function detectProtocol(t: SerialTransport, sink: RadioSink, attempts = 4): Promise<Protocol> {
  const mt = new MtDecoder()
  const mc = new McDecoder()
  let found: Protocol | null = null
  let wake: () => void = () => {}

  t.onData = (chunk) => {
    for (const item of mc.push(chunk)) {
      if (item.type === 'frame' && item.payload[0] === Resp.DEVICE_INFO) found ??= 'meshcore'
    }
    for (const item of mt.push(chunk)) {
      if (item.type === 'text') {
        sink.log({ dir: 'text', kind: 'console', summary: item.text })
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

  for (let i = 0; i < attempts && !found; i++) {
    sink.progress(i ? `Waiting for radio (attempt ${i + 1})…` : 'Detecting protocol…')
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
  t.onData = () => {}
  if (!found) throw new Error('No Meshtastic or MeshCore radio answered on this port')
  sink.log({ dir: 'info', kind: 'detect', summary: `protocol: ${found}` })
  return found
}
