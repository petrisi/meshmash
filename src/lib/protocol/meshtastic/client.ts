import { initials } from '../../format'
import { REPEAT_WINDOW_MS } from '../../model/capabilities'
import type { Channel, MeshNode, NodeKind, RadioInfo, ThreadKey } from '../../model/types'
import { hex, utf8Decode, utf8Encode } from '../bytes'
import type { Probe, RadioClient, RadioSink, SendOptions } from '../types'
import type { SerialTransport } from '../../transport/serial'
import {
  Admin,
  BROADCAST,
  type ChannelInfo,
  decodeFromRadio,
  decodeNodeInfo,
  decodePosition,
  inferPrecisionBits,
  decodeNeighborInfo,
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

/** Firmware treats an empty PSK on a secondary channel as "use the primary key" (Channels.cpp). */
function pskSummary(psk: Uint8Array, secondary: boolean) {
  if (!psk.length) return secondary ? 'primary key' : 'none'
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
  /** The radio confirmed it took the packet (queue_status). */
  accepted: boolean
}

/** Fallback if a queue_status never names our packet. */
const ACCEPT_TIMEOUT_MS = 25_000

export class MeshtasticClient implements RadioClient {
  readonly protocol = 'meshtastic' as const

  private decoder = new FrameDecoder()
  private nonce = 0
  /** Everyone waiting for the current config download; a re-request keeps them waiting. */
  private configWaiters: { resolve: () => void; reject: (e: Error) => void }[] = []
  private configTimer: ReturnType<typeof setTimeout> | undefined
  private myNum = 0
  private metadata: Metadata = {}
  private lora: LoRaConfig = {}
  private channelInfos: ChannelInfo[] = []
  private nodes = new Map<number, NodeInfo>()
  private pending = new Map<number, Pending>()
  /** Our want_response packet id → the node action waiting for its answer. */
  private requests = new Map<number, { action: string; nodeId: string }>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private ready = false
  /** Packets are written one at a time, each after the radio took the previous one. */
  private txChain: Promise<unknown> = Promise.resolve()
  private accepting = new Map<number, () => void>()
  /** Called when the radio takes a packet (or the wait for that times out). */
  private onAccepted = new Map<number, (confirmed: boolean) => void>()
  /** When the radio last took a packet per portnum, for its per-port rate limits. */
  private lastAccepted = new Map<number, number>()

  constructor(
    private t: SerialTransport,
    private sink: RadioSink,
  ) {
    t.onData = (c) => this.onData(c)
  }

  async start(probe?: Probe) {
    this.sink.progress('Requesting configuration…')
    if (probe) {
      // Detection already asked for the config; continue with its stream.
      const done = this.awaitConfig(probe.nonce)
      probe.received.forEach((chunk, i) => this.onData(chunk, i < probe.textLogged))
      await done
    } else {
      await this.t.write(WAKE)
      await this.requestConfig()
    }
    this.heartbeat = setInterval(() => {
      if (!this.accepting.size) void this.send(toRadioHeartbeat(), 'heartbeat')
    }, 60_000)
  }

  private requestConfig() {
    const done = this.awaitConfig(safeNonce())
    void this.send(toRadioWantConfig(this.nonce), `want_config_id ${this.nonce}`)
    return done
  }

  private awaitConfig(nonce: number) {
    this.nonce = nonce
    clearTimeout(this.configTimer)
    this.configTimer = setTimeout(() => {
      for (const w of this.configWaiters.splice(0)) w.reject(new Error('Timed out waiting for configuration'))
    }, 45_000)
    return new Promise<void>((resolve, reject) => this.configWaiters.push({ resolve, reject }))
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    clearTimeout(this.configTimer)
    for (const p of this.pending.values()) clearTimeout(p.timer)
    await this.send(toRadioDisconnect(), 'disconnect').catch(() => {})
  }

  private async send(payload: Uint8Array, summary: string) {
    this.sink.log({ dir: 'tx', kind: 'ToRadio', summary, bytes: payload })
    await this.t.write(encodeFrame(payload))
  }

  private onData(chunk: Uint8Array, textLogged = false) {
    for (const item of this.decoder.push(chunk)) {
      if (item.type === 'text') {
        if (!textLogged) this.sink.log({ dir: 'text', kind: 'console', summary: item.text })
        continue
      }
      let msg: FromRadio
      try {
        msg = decodeFromRadio(item.payload)
      } catch (e) {
        this.sink.log({ dir: 'error', kind: 'FromRadio', summary: `decode failed: ${e}`, bytes: item.payload })
        continue
      }
      let summary: string
      try {
        summary = this.describe(msg)
      } catch (e) {
        summary = `describe failed: ${e}`
      }
      this.sink.log({ dir: 'rx', kind: `FromRadio.${msg.kind}`, summary, bytes: item.payload })
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
      case 'queue_status': {
        this.accepting.get(m.meshPacketId)?.()
        const pend = this.pending.get(m.meshPacketId)
        if (!pend) break
        if (m.res !== 0) {
          clearTimeout(pend.timer)
          this.pending.delete(m.meshPacketId)
          this.sink.updateMessage(pend.localId, { status: 'failed', settled: true })
        } else this.accept(m.meshPacketId)
        break
      }
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
    clearTimeout(this.configTimer)
    for (const w of this.configWaiters.splice(0)) w.resolve()
    this.sink.ready()
  }

  private channels(): Channel[] {
    return this.channelInfos
      .filter((c) => c && c.role !== 0)
      .map((c) => ({
        index: c.index,
        name: c.name || (c.role === 1 ? presetChannelName(this.lora.modemPreset) : `Channel ${c.index}`),
        kind: c.role === 1 ? 'primary' : 'secondary',
        encryption: pskSummary(c.psk, c.role === 2),
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
      position:
        pos?.lat && pos?.lon
          ? { lat: pos.lat, lon: pos.lon, alt: pos.alt, precisionBits: pos.precisionBits ?? inferPrecisionBits(pos.lat, pos.lon) }
          : undefined,
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
    const req = d.requestId ? this.requests.get(d.requestId) : undefined
    if (req && d.portnum !== Port.ROUTING) {
      this.requests.delete(d.requestId!)
      if (d.portnum === Port.TRACEROUTE) this.onTraceroute(p.from, decodeRouteDiscovery(d.payload))
      else this.sink.actionResult(req.nodeId, req.action, true, RESPONSE_TEXT[d.portnum] ?? 'Answered')
    }
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
          packetId: p.id,
          replyTo: d.replyId || undefined,
          reaction: !!d.emoji && !!d.replyId,
          pki: p.pkiEncrypted || undefined,
        })
        return
      }
      case Port.POSITION: {
        const pos = decodePosition(d.payload)
        if (pos.lat && pos.lon) {
          this.mergeNode(p.from, { position: pos })
          this.sink.node({ id: fromId, position: { lat: pos.lat, lon: pos.lon, alt: pos.alt, precisionBits: pos.precisionBits } })
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
      case Port.NEIGHBORINFO: {
        // Answers to our request and the node's periodic reports look the same.
        const nb = decodeNeighborInfo(d.payload)
        const reporter = nb.nodeId ? nodeId(nb.nodeId) : fromId
        this.sink.remote(reporter, {
          neighbours: {
            ts: now,
            total: nb.neighbors.length,
            list: nb.neighbors.map((x) => ({ id: nodeId(x.nodeId), heardSecsAgo: 0, snr: x.snr })),
          },
        })
        return
      }
      case Port.ROUTING: {
        // A request answered only by a routing error, e.g. NO_RESPONSE.
        const err = decodeRouting(d.payload).errorReason ?? 0
        if (req && err !== 0) {
          this.requests.delete(d.requestId!)
          const text =
            req.action === 'req-neighbours' && ROUTING_ERROR[err] === 'NO_RESPONSE'
              ? 'No answer: needs firmware 2.7.16+ with the neighbour info module enabled'
              : routingErrorText(err)
          this.sink.actionResult(req.nodeId, req.action, false, text)
        }
        this.onRouting(p, decodeRouting(d.payload))
        return
      }
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
    this.accept(reqId!)
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

  /**
   * Queues a MeshPacket. Resolves with its id once written; the next packet waits until the
   * radio confirms this one with queue_status. TinyUSB boards poll serial input only every
   * ~20 s and their receive buffer is small, so a burst of frames can be partly lost. The
   * firmware also silently drops packets that break its per-port rate limits.
   */
  private sendPacket(
    to: number,
    portnum: number,
    payload: Uint8Array,
    opts: { channel?: number; wantAck?: boolean; wantResponse?: boolean; replyId?: number; emoji?: number; id?: number } = {},
  ): Promise<number> {
    const id = opts.id ?? this.packetId()
    const written = this.txChain.then(async () => {
      const wait = (this.lastAccepted.get(portnum) ?? 0) + (RATE_LIMIT_MS[portnum] ?? 0) + 1000 - Date.now()
      if (RATE_LIMIT_MS[portnum] && wait > 0) {
        this.sink.log({ dir: 'info', kind: 'rate limit', summary: `${PORTNUM[portnum]} waits ${Math.ceil(wait / 1000)} s` })
        await new Promise((r) => setTimeout(r, wait))
      }
      await this.writePacket(id, to, portnum, payload, opts)
    })
    this.txChain = written
      .then(
        () =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(() => done(false), ACCEPT_TIMEOUT_MS)
            const self = this
            function done(confirmed = true) {
              clearTimeout(timer)
              self.accepting.delete(id)
              self.lastAccepted.set(portnum, Date.now())
              self.onAccepted.get(id)?.(confirmed)
              self.onAccepted.delete(id)
              resolve()
            }
            this.accepting.set(id, done)
          }),
      )
      .catch(() => {})
    return written.then(() => id)
  }

  private async writePacket(
    id: number,
    to: number,
    portnum: number,
    payload: Uint8Array,
    opts: { channel?: number; wantAck?: boolean; wantResponse?: boolean; replyId?: number; emoji?: number },
  ) {
    await this.send(
      toRadioPacket({
        to,
        channel: opts.channel ?? 0,
        id,
        wantAck: opts.wantAck ?? false,
        wantResponse: opts.wantResponse,
        replyId: opts.replyId,
        emoji: opts.emoji,
        hopLimit: this.lora.hopLimit || 3,
        portnum,
        payload,
      }),
      `${PORTNUM[portnum]} → ${to === BROADCAST ? 'broadcast' : this.name(to)} id ${id}`,
    )
  }

  async sendText(thread: ThreadKey, text: string, localId: string, opts: SendOptions = {}) {
    const isDm = thread.startsWith('dm:')
    const to = isDm ? nodeNum(thread.slice(3)) : BROADCAST
    const channel = isDm ? 0 : Number(thread.slice(3))
    // Known before the radio takes the packet (up to ~25 s on some boards), so the message
    // can be replied to or reacted to right away.
    const id = this.packetId()
    this.sink.updateMessage(localId, { packetId: id })
    await this.sendPacket(to, Port.TEXT, utf8Encode(text), {
      channel,
      wantAck: true,
      replyId: opts.replyTo,
      emoji: opts.reaction ? 1 : undefined,
      id,
    })
    // Some boards read serial input only every ~20 s; stay 'pending' until the radio takes it.
    this.pending.set(id, { localId, to, accepted: false, timer: setTimeout(() => this.accept(id), ACCEPT_TIMEOUT_MS) })
  }

  private accept(id: number) {
    const pend = this.pending.get(id)
    if (!pend || pend.accepted) return
    pend.accepted = true
    clearTimeout(pend.timer)
    this.sink.updateMessage(pend.localId, { status: 'sent' })
    pend.timer = setTimeout(() => {
      this.pending.delete(id)
      this.sink.updateMessage(pend.localId, { settled: true })
    }, REPEAT_WINDOW_MS)
  }

  async action(action: string, id: string) {
    const num = nodeNum(id)
    const self = this.nodes.get(this.myNum)
    switch (action) {
      case 'req-neighbours': {
        const pid = await this.sendPacket(num, Port.NEIGHBORINFO, new Uint8Array(), { wantResponse: true })
        this.requests.set(pid, { action, nodeId: id })
        return
      }
      case 'traceroute': {
        const pid = await this.sendPacket(num, Port.TRACEROUTE, new Uint8Array(), { wantResponse: true })
        this.requests.set(pid, { action, nodeId: id })
        return
      }
      case 'req-position': {
        const payload = self?.position ? encodePosition(self.position) : new Uint8Array()
        const pid = await this.sendPacket(num, Port.POSITION, payload, { wantResponse: true })
        this.requests.set(pid, { action, nodeId: id })
        return
      }
      case 'req-telemetry': {
        const pid = await this.sendPacket(num, Port.TELEMETRY, encodeTelemetryRequest(), { wantResponse: true })
        this.requests.set(pid, { action, nodeId: id })
        return
      }
      case 'exchange-info': {
        if (!self?.user) throw new Error('own user info unknown')
        const pid = await this.sendPacket(num, Port.NODEINFO, ownUser(self.user), { wantResponse: true })
        this.requests.set(pid, { action, nodeId: id })
        return
      }
      case 'send-nodeinfo':
      case 'send-position': {
        const isInfo = action === 'send-nodeinfo'
        if (isInfo ? !self?.user : !self?.position?.lat) throw new Error(isInfo ? 'Own user info unknown' : 'Own position unknown')
        const payload = isInfo ? ownUser(self!.user!) : encodePosition(self!.position!)
        const pid = await this.sendPacket(BROADCAST, isInfo ? Port.NODEINFO : Port.POSITION, payload)
        this.onAccepted.set(pid, (ok) =>
          this.sink.actionResult(id, action, ok, ok ? 'Broadcast sent' : 'Radio did not confirm'),
        )
        return
      }
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

/**
 * Our User exactly as the radio reported it. The firmware stores a NODEINFO we send as its own
 * entry; a re-encoded copy lacks macaddr, and on the next boot NodeDB::pickNewNodeNum then sees
 * a MAC mismatch and switches to a random node number.
 */
const ownUser = (u: User) => u.raw ?? encodeUser(u)

/** PhoneAPI::handleToRadioPacket drops faster repeats of these ports (ms). */
const RATE_LIMIT_MS: Record<number, number> = {
  [Port.TRACEROUTE]: 30_000,
  [Port.POSITION]: 10_000,
  [Port.TELEMETRY]: 10_000,
  [Port.TEXT]: 2_000,
}

const RESPONSE_TEXT: Record<number, string> = {
  [Port.POSITION]: 'Position received',
  [Port.TELEMETRY]: 'Telemetry received',
  [Port.NODEINFO]: 'User info received',
  [Port.NEIGHBORINFO]: 'Neighbours received',
}

function routingErrorText(err: number): string {
  switch (ROUTING_ERROR[err]) {
    case 'NO_RESPONSE': return 'Node had nothing to send back (no data, or rate-limited)'
    case 'MAX_RETRANSMIT': return 'No acknowledgement after retries'
    case 'NO_ROUTE': return 'No route to node'
    case 'TIMEOUT': return 'Timed out'
    case 'PKI_SEND_FAIL_PUBLIC_KEY': return "Node's public key unknown; exchange user info first"
    case 'PKI_UNKNOWN_PUBKEY': return 'Node does not know our public key'
    case 'RATE_LIMIT_EXCEEDED': return 'Rate limited by the radio'
    default: return `Failed: ${ROUTING_ERROR[err] ?? err}`
  }
}

// Exported for offline tests.
export { decodeFromRadio, decodeNodeInfo }
