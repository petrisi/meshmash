// Demo radio: what a real radio would store or answer, for the demo session. All data is made up.
import { sameBytes } from '../model/channels'
import type { Channel, ChannelConfig, ContactSettings, MeshNode, Protocol, RemoteData } from '../model/types'
import { hashtagSecret } from '../protocol/meshcore/codec'

const round = (x: number, step: number) => Math.round(x / step) * step

export class DemoRadio {
  private configs = new Map<number, ChannelConfig>()
  contactSettings: ContactSettings = { manual: false, chat: true, repeater: true, room: true, sensor: true, overwriteOldest: true, maxHops: 0 }

  constructor(
    readonly protocol: Protocol,
    configs: ChannelConfig[],
  ) {
    for (const c of configs) this.configs.set(c.index, c)
  }

  /** MeshCore hashtag keys come from the name; fills in the ones left empty. */
  async init() {
    for (const c of this.configs.values()) if (c.name.startsWith('#') && c.key.every((b) => b === 0)) c.key = await hashtagSecret(c.name)
  }

  channelConfig(index: number): ChannelConfig | undefined {
    return this.configs.get(index)
  }

  async setChannel(c: ChannelConfig): Promise<Channel[]> {
    this.configs.set(c.index, { ...c, key: c.key.slice() })
    return this.channels()
  }

  async deleteChannel(index: number): Promise<Channel[]> {
    this.configs.delete(index)
    return this.channels()
  }

  /** The channel list as the protocol clients report it. */
  async channels(): Promise<Channel[]> {
    const out: Channel[] = []
    for (const c of [...this.configs.values()].sort((a, b) => a.index - b.index)) {
      if (this.protocol === 'meshtastic') {
        const k = c.key
        const encryption = !k.length ? (c.index ? 'primary key' : 'none') : k.length === 1 ? (k[0] === 0 ? 'none' : k[0] === 1 ? 'default key' : `simple key ${k[0]}`) : `AES-${k.length * 8}`
        out.push({ index: c.index, name: c.name || (c.index ? `Channel ${c.index}` : 'LongFast'), kind: c.index ? 'secondary' : 'primary', encryption })
      } else {
        const hashtag = c.name.startsWith('#') && sameBytes(c.key, await hashtagSecret(c.name))
        const isPublic = c.index === 0 && c.name === 'Public'
        out.push({
          index: c.index,
          name: c.name,
          kind: isPublic ? 'public' : hashtag ? 'hashtag' : 'private',
          encryption: hashtag ? 'hashtag key' : isPublic ? 'public key' : 'AES-128',
        })
      }
    }
    return out
  }

  status(node: MeshNode): RemoteData['status'] {
    const up = node.uptimeS ?? 5 * 86400
    const rx = Math.floor(up / 9)
    return {
      ts: Date.now(),
      fields: [
        { label: 'Battery', value: `${(3.6 + Math.random() * 0.5).toFixed(2)} V` },
        { label: 'Uptime', value: `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` },
        { label: 'Noise floor', value: `${-118 + Math.floor(Math.random() * 8)} dBm` },
        { label: 'Last RSSI / SNR', value: `${-90 - Math.floor(Math.random() * 30)} dBm / ${round(Math.random() * 16 - 6, 0.25)} dB` },
        { label: 'Packets rx / tx', value: `${rx} / ${Math.floor(rx * 0.6)}` },
        { label: 'Tx queue', value: '0' },
      ],
    }
  }

  telemetry(node: MeshNode): RemoteData['telemetry'] {
    const readings = [{ channel: 1, type: 116, name: 'Voltage', value: `${(3.6 + Math.random() * 0.5).toFixed(2)} V` }]
    if (node.kind === 'sensor') {
      readings.push({ channel: 2, type: 103, name: 'Temperature', value: `${round(Math.random() * 25 - 5, 0.1).toFixed(1)} °C` })
      readings.push({ channel: 2, type: 104, name: 'Humidity', value: `${Math.floor(40 + Math.random() * 50)} %` })
    }
    return { ts: Date.now(), readings }
  }

  /** Neighbours: nodes heard directly, a few of them. */
  neighbours(nodes: MeshNode[], exclude: string[], withSnrThere = false): RemoteData['neighbours'] {
    const pool = nodes.filter((n) => n.hops === 0 && !exclude.includes(n.id))
    const list = pool.slice(0, 3 + Math.floor(Math.random() * 6)).map((n) => ({
      id: n.id,
      heardSecsAgo: Math.floor(Math.random() * 3600),
      snr: round(Math.random() * 20 - 10, 0.25),
      snrThere: withSnrThere ? round(Math.random() * 20 - 10, 0.25) : undefined,
    }))
    return { ts: Date.now(), total: list.length, list }
  }

  owner(node: MeshNode): RemoteData['owner'] {
    return { ts: Date.now(), text: `${node.longName}\nRun by the local mesh club (demo)` }
  }

  cliReply(node: MeshNode, cmd: string): string {
    const [verb, ...rest] = cmd.trim().split(/\s+/)
    if (verb === 'ver') return 'v1.17.1-demo (Build: 1 Jan 2026)'
    if (verb === 'clock') return new Date().toISOString().slice(11, 19) + ' - ' + new Date().toISOString().slice(0, 10)
    if (verb === 'get' && rest[0] === 'name') return `> ${node.longName}`
    if (verb === 'get' && rest[0] === 'radio') return '> 869.618,62.5,8,8'
    if (verb === 'get' && rest[0] === 'tx') return '> 22'
    if (verb === 'neighbors') return '-none-'
    if (verb === 'set' && rest.length > 1) return 'OK (demo: not stored)'
    return 'Unknown command'
  }
}
