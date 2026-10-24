import { initials } from '../../format'
import { REPEAT_WINDOW_MS } from '../../model/capabilities'
import type { Channel, MeshNode, NodeKind, RadioInfo, ThreadKey } from '../../model/types'
import { hex, utf8Decode, utf8Encode } from '../bytes'
import type { RadioClient, RadioSink } from '../types'
import type { SerialTransport } from '../../transport/serial'
import {
  Admin,
  BROADCAST,
  type ChannelInfo,
  decodeFromRadio,
  decodeNodeInfo,
  decodePosition,
  decodeRouteDiscovery,
  decodeRouting,
  decodeTelemetry,
  decodeUser,
  encodeAdminUint,
  encodePosition,
  encodeTelemetryRequest,
  encodeUser,
  type FromRadio,
  type LoRaConfig,
  type MeshPacket,
  type Metadata,
  type NodeInfo,
  Port,
  toRadioDisconnect,
  toRadioHeartbeat,
  toRadioPacket,
  toRadioWantConfig,
  type User,
} from './codec'
import { HW_MODEL, MODEM_PRESET, PORTNUM, REGION, ROLE, ROUTING_ERROR } from './enums'
import { encodeFrame, FrameDecoder, WAKE } from './framing'

export const nodeId = (num: number) => `!${(num >>> 0).toString(16).padStart(8, '0')}`
const nodeNum = (id: string) => parseInt(id.slice(1), 16) >>> 0

const ROLE_KIND: Record<string, NodeKind> = {
  CLIENT_MUTE: 'client_mute',
  CLIENT_HIDDEN: 'client_mute',
  ROUTER: 'router',
  ROUTER_CLIENT: 'router',
  ROUTER_LATE: 'router',
  REPEATER: 'router',
  TRACKER: 'tracker',
  TAK_TRACKER: 'tracker',
  SENSOR: 'sensor',
}

/** "LONG_FAST" → "LongFast", the name firmware uses for an unnamed primary channel. */
/** Bandwidth codes the firmware maps to fractional kHz. */
const BANDWIDTH_KHZ: Record<number, number> = { 31: 31.25, 62: 62.5, 200: 203.125, 400: 406.25, 800: 812.5, 1600: 1625 }

function presetChannelName(preset?: number) {
  const n = MODEM_PRESET[preset ?? 0] ?? 'LONG_FAST'
  return n
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}

function pskSummary(psk: Uint8Array) {
  if (!psk.length) return 'none'
  if (psk.length === 1) return psk[0] === 0 ? 'none' : psk[0] === 1 ? 'default key' : `simple key ${psk[0]}`
  return `AES-${psk.length * 8}`
}

/** Nonce whose want_config encoding has no '<' byte, which would look like a MeshCore frame. */
function safeNonce() {
  for (;;) {
    const n = 1 + Math.floor(Math.random() * 0x7ffffff0)
    if (!toRadioWantConfig(n).includes(0x3c)) return n
  }
}

interface Pending {
  localId: string
  to: number
  timer: ReturnType<typeof setTimeout>
}

export class MeshtasticClient implements RadioClient {
  readonly protocol = 'meshtastic' as const

  private decoder = new FrameDecoder()
  private nonce = 0
  private configDone: (() => void) | null = null
  private myNum = 0
  private metadata: Metadata = {}
  private lora: LoRaConfig = {}
  private channelInfos: ChannelInfo[] = []
  private nodes = new Map<number, NodeInfo>()
  private pending = new Map<number, Pending>()
  private traceroutes = new Map<number, number>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private ready = false

  constructor(
    private t: SerialTransport,
    private sink: RadioSink,
  ) {
    t.onData = (c) => this.onData(c)
  }

  async start() {
    this.sink.progress('Requesting configuration…')
    await this.t.write(WAKE)
    await this.requestConfig()
    this.heartbeat = setInterval(() => void this.send(toRadioHeartbeat(), 'heartbeat'), 60_000)
  }

  private requestConfig() {
    this.nonce = safeNonce()
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for configuration')), 45_000)
      this.configDone = () => {
        clearTimeout(timer)
        resolve()
      }
    })
    void this.send(toRadioWantConfig(this.nonce), `want_config_id ${this.nonce}`)
    return done
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const p of this.pending.values()) clearTimeout(p.timer)
    await this.send(toRadioDisconnect(), 'disconnect').catch(() => {})
  }

  private async send(payload: Uint8Array, summary: string) {
    this.sink.log({ dir: 'tx', kind: 'ToRadio', summary, bytes: payload })
    await this.t.write(encodeFrame(payload))
  }

  private onData(chunk: Uint8Array) {
    for (const item of this.decoder.push(chunk)) {
      if (item.type === 'text') {
        this.sink.log({ dir: 'text', kind: 'console', summary: item.text })
        continue
      }
      let msg: FromRadio
      try {
        msg = decodeFromRadio(item.payload)
      } catch (e) {
        this.sink.log({ dir: 'error', kind: 'FromRadio', summary: `decode failed: ${e}`, bytes: item.payload })
        continue
      }
      this.sink.log({ dir: 'rx', kind: `FromRadio.${msg.kind}`, summary: this.describe(msg), bytes: item.payload })
      try {
        this.handle(msg)
      } catch (e) {
        this.sink.log({ dir: 'error', kind: msg.kind, summary: String(e) })
      }
    }
  }

  private name(num: number) {
    return this.nodes.get(num)?.user?.longName ?? nodeId(num)
  }

  private describe(m: FromRadio): string {
    switch (m.kind) {
      case 'packet': {
        const p = m.packet
        const port = p.decoded ? (PORTNUM[p.decoded.portnum] ?? p.decoded.portnum) : 'encrypted'
        const to = p.to === BROADCAST ? `ch${p.channel}` : this.name(p.to)
        const hops = p.hopStart ? ` ${p.hopStart - (p.hopLimit ?? 0)}/${p.hopStart}` : ''
        const sig = p.rxSnr ? ` snr ${p.rxSnr} rssi ${p.rxRssi}` : ''
        return `${port} ${this.name(p.from)} → ${to}${hops}${sig}`
      }
      case 'my_info': return `node ${nodeId(m.myInfo.myNodeNum)} reboots ${m.myInfo.rebootCount ?? 0} env ${m.myInfo.pioEnv ?? ''}`
      case 'node_info': return `${nodeId(m.node.num)} ${m.node.user?.longName ?? ''} (${m.node.user?.shortName ?? ''})`
      case 'config': return m.section
      case 'channel': return `#${m.channel.index} ${m.channel.name || '(unnamed)'} role ${m.channel.role}`
      case 'metadata': return `fw ${m.metadata.firmwareVersion} hw ${HW_MODEL[m.metadata.hwModel ?? 0] ?? m.metadata.hwModel}`
      case 'config_complete_id': return `${m.nonce}${m.nonce === this.nonce ? '' : ' (not ours)'}`
      case 'queue_status': return `free ${m.free}/${m.maxlen} res ${m.res} id ${m.meshPacketId}`
      case 'log_record': return `${m.source ? `[${m.source}] ` : ''}${m.message}`
      case 'client_notification': return m.message
      case 'other': return `field ${m.field}`
      default: return ''
    }
  }

  private handle(m: FromRadio) {
    switch (m.kind) {
      case 'my_info':
        this.myNum = m.myInfo.myNodeNum
        break
      case 'metadata':
        this.metadata = m.metadata
        break
      case 'node_info':
        this.nodes.set(m.node.num, m.node)
        if (this.ready) this.sink.node(this.toNode(m.node))
        else if (this.nodes.size % 25 === 0) this.sink.progress(`Receiving nodes… ${this.nodes.size}`)
        break
      case 'channel':
        this.channelInfos[m.channel.index] = m.channel
        break
      case 'config':
        if (m.lora) this.lora = m.lora
        break
      case 'config_complete_id':
        if (m.nonce === this.nonce) this.onConfigComplete()
        break
      case 'rebooted':
        this.sink.progress('Radio rebooted, reloading…')
        this.ready = false
        void this.requestConfig()
        break
      case 'packet':
        this.onPacket(m.packet)
        break
    }
  }

  private onConfigComplete() {
    const self = this.nodes.get(this.myNum)
    // proto3 omits false, so a missing use_preset means custom modem settings.
    const l = this.lora
    const preset = l.usePreset
      ? (MODEM_PRESET[l.modemPreset ?? 0] ?? `preset ${l.modemPreset}`)
      : `BW${BANDWIDTH_KHZ[l.bandwidth ?? 0] ?? l.bandwidth} SF${l.spreadFactor} CR4/${l.codingRate}`
    const info: RadioInfo = {
      protocol: 'meshtastic',
      firmware: this.metadata.firmwareVersion ?? '?',
      hwModel: HW_MODEL[this.metadata.hwModel ?? self?.user?.hwModel ?? 0] ?? 'unknown',
      nodeId: nodeId(this.myNum),
      longName: self?.user?.longName ?? nodeId(this.myNum),
      shortName: self?.user?.shortName ?? '',
      radio: {
        region: REGION[this.lora.region ?? 0],
        preset,
        freqMHz: this.lora.overrideFrequency || undefined,
        txPowerDbm: this.lora.txPower || undefined,
      },
      batteryPct: self?.deviceMetrics?.batteryLevel,
      voltage: self?.deviceMetrics?.voltage,
      position: this.toNode(self ?? { num: this.myNum }).position,
    }
    this.sink.info(info, { maxChannels: 8 })
    for (const n of this.nodes.values()) this.sink.node(this.toNode(n))
    this.sink.channels(this.channels())
    this.ready = true
    this.configDone?.()
    this.configDone = null
    this.sink.ready()
  }

  private channels(): Channel[] {
    return this.channelInfos
      .filter((c) => c && c.role !== 0)
      .map((c) => ({
        index: c.index,
        name: c.name || (c.role === 1 ? presetChannelName(this.lora.modemPreset) : `Channel ${c.index}`),
        kind: c.role === 1 ? 'primary' : 'secondary',
        encryption: pskSummary(c.psk),
        muted: c.muted,
      }))
  }

  private toNode(n: NodeInfo): MeshNode {
    const u = n.user ?? {}
    const role = ROLE[u.role ?? 0] ?? 'CLIENT'
    const longName = u.longName || nodeId(n.num)
    const pos = n.position
    return {
      id: nodeId(n.num),
      longName,
      shortName: u.shortName || initials(longName, 4),
      kind: ROLE_KIND[role] ?? 'client',
      role,
      hwModel: u.hwModel !== undefined ? (HW_MODEL[u.hwModel] ?? `#${u.hwModel}`) : undefined,
      publicKey: u.publicKey?.length ? hex(u.publicKey) : undefined,
      lastHeard: n.lastHeard ? n.lastHeard * 1000 : undefined,
      snr: n.hopsAway === 0 && n.snr ? n.snr : undefined,
      hops: n.hopsAway ?? (n.num === this.myNum ? 0 : undefined),
      batteryPct: n.deviceMetrics?.batteryLevel,
      voltage: n.deviceMetrics?.voltage,
      channelUtil: n.deviceMetrics?.channelUtil !== undefined ? round1(n.deviceMetrics.channelUtil) : undefined,
      airUtilTx: n.deviceMetrics?.airUtilTx !== undefined ? round1(n.deviceMetrics.airUtilTx) : undefined,
      uptimeS: n.deviceMetrics?.uptime,
      position: pos?.lat && pos?.lon ? { lat: pos.lat, lon: pos.lon, alt: pos.alt } : undefined,
      favorite: n.isFavorite,
      ignored: n.isIgnored,
      viaMqtt: n.viaMqtt,
    }
  }

  private onPacket(p: MeshPacket) {
    const now = Date.now()
    const fromId = nodeId(p.from)
    // After config, firmware replays stored packets (latest position/telemetry per node)
    // with their original rx_time but without hop_limit or RSSI. Those are history, not
    // "heard now", and their hop count is unknown.
    const rxAt = p.rxTime ? Math.min(p.rxTime * 1000, now) : now
    const replayed = now - rxAt > 120_000
    const hops = p.hopStart && !replayed ? p.hopStart - (p.hopLimit ?? 0) : undefined

    if (p.from !== this.myNum) {
      const known = this.nodes.get(p.from)
      const newer = rxAt > (known?.lastHeard ?? 0) * 1000
      this.sink.heard(fromId, rxAt, p.channel)
      const patch: Partial<MeshNode> & { id: string } = { id: fromId }
      if (newer) patch.lastHeard = rxAt
      if (hops !== undefined) patch.hops = hops
      if (hops === 0 && p.rxSnr) {
        patch.snr = p.rxSnr
        patch.rssi = p.rxRssi
      }
      if (!known) {
        this.nodes.set(p.from, { num: p.from, lastHeard: rxAt / 1000 })
        this.sink.node({ ...this.toNode({ num: p.from }), ...patch })
      } else {
        if (newer) known.lastHeard = rxAt / 1000
        this.sink.node(patch)
      }
    }

    const d = p.decoded
    if (!d) return
    switch (d.portnum) {
      case Port.TEXT: {
        if (p.from === this.myNum) return
        const thread: ThreadKey = p.to === BROADCAST ? `ch:${p.channel}` : `dm:${fromId}`
        this.sink.message({
          id: `mt-${fromId}-${p.id}`,
          thread,
          from: fromId,
          text: utf8Decode(d.payload),
          ts: p.rxTime ? Math.min(p.rxTime * 1000, now) : now,
          status: 'received',
          hops,
          hopStart: p.hopStart || undefined,
          snr: p.rxSnr || undefined,
          rssi: p.rxRssi || undefined,
        })
        return
      }
      case Port.POSITION: {
        const pos = decodePosition(d.payload)
        if (pos.lat && pos.lon) {
          this.mergeNode(p.from, { position: pos })
          this.sink.node({ id: fromId, position: { lat: pos.lat, lon: pos.lon, alt: pos.alt } })
        }
        return
      }
      case Port.NODEINFO: {
        const u: User = decodeUser(d.payload)
        this.mergeNode(p.from, { user: u })
        this.sink.node(this.toNode(this.nodes.get(p.from)!))
        return
      }
      case Port.TELEMETRY: {
        const m = decodeTelemetry(d.payload).deviceMetrics
        if (m) {
          this.mergeNode(p.from, { deviceMetrics: m })
          this.sink.node({
            id: fromId,
            batteryPct: m.batteryLevel,
            voltage: m.voltage,
            channelUtil: m.channelUtil !== undefined ? round1(m.channelUtil) : undefined,
            airUtilTx: m.airUtilTx !== undefined ? round1(m.airUtilTx) : undefined,
            uptimeS: m.uptime,
          })
        }
        return
      }
      case Port.ROUTING:
        this.onRouting(p, decodeRouting(d.payload))
        return
      case Port.TRACEROUTE:
        if (d.requestId && this.traceroutes.has(d.requestId)) {
          this.traceroutes.delete(d.requestId)
          this.onTraceroute(p.from, decodeRouteDiscovery(d.payload))
        }
        return
    }
  }

  private mergeNode(num: number, patch: Partial<NodeInfo>) {
    const n = this.nodes.get(num) ?? { num }
    this.nodes.set(num, { ...n, ...patch })
  }

  /** ACK/NAK for a packet we sent. From ourselves = implicit ACK (a rebroadcast was heard). */
  private onRouting(p: MeshPacket, r: ReturnType<typeof decodeRouting>) {
    const reqId = p.decoded?.requestId
    const pend = reqId !== undefined ? this.pending.get(reqId) : undefined
    if (!pend) return
    const err = r.errorReason ?? 0
    if (err !== 0) {
      this.sink.updateMessage(pend.localId, { status: 'failed', settled: true })
      this.sink.log({ dir: 'info', kind: 'routing', summary: `send failed: ${ROUTING_ERROR[err] ?? err}` })
      clearTimeout(pend.timer)
      this.pending.delete(reqId!)
    } else if (p.from === this.myNum) {
      this.sink.updateMessage(pend.localId, { repeats: 1 })
    } else if (p.from === pend.to) {
      this.sink.updateMessage(pend.localId, { status: 'acked', repeats: 1 })
    }
  }

  private onTraceroute(target: number, r: ReturnType<typeof decodeRouteDiscovery>) {
    const ids = (nums: number[]) => nums.map(nodeId)
    const snr = (v: number[]) => v.map((x) => (x === -128 ? NaN : x / 4))
    this.sink.traceroute({
      nodeId: nodeId(target),
      ts: Date.now(),
      towards: [nodeId(this.myNum), ...ids(r.route), nodeId(target)],
      snrTowards: snr(r.snrTowards),
      back: r.snrBack.length ? [nodeId(target), ...ids(r.routeBack), nodeId(this.myNum)] : undefined,
      snrBack: r.snrBack.length ? snr(r.snrBack) : undefined,
    })
  }

  private packetId() {
    return (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0
  }

  private async sendPacket(
    to: number,
    portnum: number,
    payload: Uint8Array,
    opts: { channel?: number; wantAck?: boolean; wantResponse?: boolean } = {},
  ) {
    const id = this.packetId()
    await this.send(
      toRadioPacket({
        to,
        channel: opts.channel ?? 0,
        id,
        wantAck: opts.wantAck ?? false,
        wantResponse: opts.wantResponse,
        hopLimit: this.lora.hopLimit || 3,
        portnum,
        payload,
      }),
      `${PORTNUM[portnum]} → ${to === BROADCAST ? 'broadcast' : this.name(to)} id ${id}`,
    )
    return id
  }

  async sendText(thread: ThreadKey, text: string, localId: string) {
    const isDm = thread.startsWith('dm:')
    const to = isDm ? nodeNum(thread.slice(3)) : BROADCAST
    const channel = isDm ? 0 : Number(thread.slice(3))
    const id = await this.sendPacket(to, Port.TEXT, utf8Encode(text), { channel, wantAck: true })
    this.sink.updateMessage(localId, { status: 'sent' })
    const timer = setTimeout(() => {
      this.pending.delete(id)
      this.sink.updateMessage(localId, { settled: true })
    }, REPEAT_WINDOW_MS)
    this.pending.set(id, { localId, to, timer })
  }

  async action(action: string, id: string) {
    const num = nodeNum(id)
    const self = this.nodes.get(this.myNum)
    switch (action) {
      case 'traceroute': {
        const pid = await this.sendPacket(num, Port.TRACEROUTE, new Uint8Array(), { wantResponse: true })
        this.traceroutes.set(pid, num)
        return
      }
      case 'req-position':
        await this.sendPacket(num, Port.POSITION, self?.position ? encodePosition(self.position) : new Uint8Array(), {
          wantResponse: true,
        })
        return
      case 'req-telemetry':
        await this.sendPacket(num, Port.TELEMETRY, encodeTelemetryRequest(), { wantResponse: true })
        return
      case 'exchange-info':
        if (self?.user) await this.sendPacket(num, Port.NODEINFO, encodeUser(self.user), { wantResponse: true })
        return
      case 'send-nodeinfo':
        if (self?.user) await this.sendPacket(BROADCAST, Port.NODEINFO, encodeUser(self.user))
        return
      case 'send-position':
        if (self?.position?.lat) await this.sendPacket(BROADCAST, Port.POSITION, encodePosition(self.position))
        else this.sink.log({ dir: 'info', kind: 'position', summary: 'own position unknown, nothing sent' })
        return
      case 'favorite':
      case 'ignore':
      case 'remove': {
        const n = this.nodes.get(num)
        const field =
          action === 'favorite'
            ? n?.isFavorite ? Admin.REMOVE_FAVORITE : Admin.SET_FAVORITE
            : action === 'ignore'
              ? n?.isIgnored ? Admin.REMOVE_IGNORED : Admin.SET_IGNORED
              : Admin.REMOVE_BY_NODENUM
        await this.sendPacket(this.myNum, Port.ADMIN, encodeAdminUint(field, num), { wantResponse: true })
        if (action === 'remove') {
          this.nodes.delete(num)
          this.sink.removeNode(id)
        } else if (n) {
          if (action === 'favorite') n.isFavorite = !n.isFavorite
          else n.isIgnored = !n.isIgnored
          this.sink.node({ id, favorite: n.isFavorite, ignored: n.isIgnored })
        }
        return
      }
      default:
        this.sink.log({ dir: 'info', kind: 'action', summary: `${action}: not implemented yet` })
    }
  }
}

const round1 = (x: number) => Math.round(x * 10) / 10

// Exported for offline tests.
export { decodeFromRadio, decodeNodeInfo }
