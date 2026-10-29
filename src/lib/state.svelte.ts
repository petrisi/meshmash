import { capabilitiesFor, REPEAT_WINDOW_MS } from './model/capabilities'
import { channelReplaced } from './model/channels'
import type {
  ActionResult,
  Capabilities,
  Channel,
  ChannelConfig,
  ContactSettings,
  FoundRoute,
  MeshNode,
  Message,
  Protocol,
  RadioInfo,
  RemoteData,
  Sample,
  ThreadKey,
  TracerouteResult,
} from './model/types'
import { DemoRadio } from './mock/demo'
import { mockSession } from './mock/mock'
import { relayByte } from './model/relay'
import { initials } from './format'
import { parseContactLink } from './protocol/meshcore/links'
import { detectProtocol } from './protocol/detect'
import { MeshCoreClient } from './protocol/meshcore/client'
import { MeshtasticClient } from './protocol/meshtastic/client'
import type { LogEntry, Probe, RadioClient, RadioSink } from './protocol/types'
import { redactCli, sanitizeSink } from './sanitize'
import { deleteMessages, loadMessages, loadNodeData, saveMessage, saveNodeData } from './store/db'
import { saveHopLimit } from './store/hopLimits'
import { loadLastRead, saveLastRead } from './store/lastRead'
import { candidatePorts, loadLastRadio, saveLastRadio } from './transport/lastRadio'
import { rememberPortName } from './transport/portNames'
import { SerialTransport } from './transport/serial'
import type { Transport } from './transport/types'

export type View = 'messages' | 'nodes' | 'map' | 'log'

const viaOf = (t: Transport) => (t instanceof SerialTransport ? 'usb' : 'bridge')
/** Web Lock held by the tab connected to a radio; all tabs of the site see it. */
const lockName = (nodeId: string) => `meshmash.radio.${nodeId}`

async function openElsewhere(nodeId: string): Promise<boolean> {
  if (!('locks' in navigator)) return false
  const { held = [] } = await navigator.locks.query()
  return held.some((l) => l.name === lockName(nodeId))
}

const LOG_MAX = 5000
let localSeq = 0
/** MeshNode fields kept as telemetry history. */
const SAMPLED = ['batteryPct', 'voltage', 'channelUtil', 'airUtilTx', 'snr', 'rssi'] as const
const SAMPLES_MAX = 1000
/** Actions that report a result: shown as pending until the radio or the other node answers. */
const REQUEST_ACTIONS = new Set([
  'traceroute', 'req-position', 'req-telemetry', 'exchange-info',
  'path-discovery', 'trace', 'req-status', 'req-neighbours', 'req-owner',
  'advert-zero', 'advert-flood', 'send-nodeinfo', 'send-position', 'use-path', 'discover', 'add-contact', 'share', 'reset-path',
])
/** Likely reasons when a request times out. */
const TIMEOUT_TEXT: Record<string, string> = {
  'req-neighbours': 'No answer (Meshtastic: needs 2.7.16+ with neighbour info enabled)',
  'req-position': 'No answer (node may have no position, or answered within the last 3 min)',
  'exchange-info': 'No answer (nodes answer each requester at most every 12 h)',
}
/** Covers slow serial polling plus a multi-hop round trip. */
const REQUEST_TIMEOUT_MS = 90_000

export interface Session {
  info: RadioInfo
  caps: Capabilities
  transport: string
}

class AppState {
  session = $state<Session | null>(null)
  nodes = $state<MeshNode[]>([])
  channels = $state<Channel[]>([])
  messages = $state<Message[]>([])
  /** DM threads the user keeps open, newest activity first via `threads`. */
  dmPeers = $state<string[]>([])
  lastRead = $state<Record<string, number>>({})
  /** Where the reader left off in the thread just opened, for the "New messages" divider. */
  readMark = $state<{ thread: ThreadKey; ts: number } | null>(null)
  /** Message to scroll to and highlight (from search). */
  focus = $state<{ id: string; at: number } | null>(null)
  traceroutes = $state<Record<string, TracerouteResult>>({})
  /** Newest first, per node, this session. */
  traceHistory = $state<Record<string, TracerouteResult[]>>({})
  /** MeshCore: latest route found by path discovery, per node. */
  foundRoutes = $state<Record<string, FoundRoute>>({})
  /** Pending request action per node id. */
  busy = $state<Record<string, string>>({})
  /** Latest result per node id and action. */
  results = $state<Record<string, Record<string, ActionResult>>>({})
  remote = $state<Record<string, RemoteData>>({})
  /** Telemetry history per node, oldest first. */
  samples = $state<Record<string, Sample[]>>({})
  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Per channel: node id → last time heard on that channel. Meshtastic counts any packet
   * (every packet carries a channel); MeshCore only channel messages.
   */
  channelHeard = $state<Record<string, Record<string, number>>>({})

  view = $state<View>('messages')
  activeThread = $state<ThreadKey | null>(null)
  selectedNode = $state<string | null>(null)
  /** The channel slot open in the channel editor. */
  channelEditor = $state<{ index: number; isNew: boolean } | null>(null)
  /** Set by showOnMap; the map centres on this node when n changes. */
  mapFocus = $state<{ id: string; n: number } | null>(null)
  log = $state<LogEntry[]>([])
  /** Set while a radio connection is being established. */
  connecting = $state<string | null>(null)
  /** The last connection failure, and which kind of connection it was about. */
  connectError = $state<{ text: string; via: 'usb' | 'bridge' } | null>(null)
  /** Releases the lock that marks the connected radio as open in this tab. */
  #releaseLock: (() => void) | null = null
  #client: RadioClient | null = null
  /** Demo session: stands in for the radio's stored settings and answers. */
  #demo: DemoRadio | null = null
  #transport: Transport | null = null
  /** Bumped by every connect and disconnect; an older attempt that finishes is dropped. */
  #connectGen = 0
  /** Ticks every second so relative times ("3s", "47m") stay current. */
  now = $state(Date.now())
  #timers: ReturnType<typeof setInterval>[] = []

  protocol = $derived<Protocol | null>(this.session?.info.protocol ?? null)
  selfId = $derived(this.session?.info.nodeId ?? '')
  nodeById = $derived(new Map(this.nodes.map((n) => [n.id, n])))

  byThread = $derived.by(() => {
    const m = new Map<ThreadKey, Message[]>()
    for (const msg of this.messages) {
      let arr = m.get(msg.thread)
      if (!arr) m.set(msg.thread, (arr = []))
      arr.push(msg)
    }
    return m
  })

  unread(thread: ThreadKey): number {
    const since = this.lastRead[thread] ?? 0
    const msgs = this.byThread.get(thread) ?? []
    let n = 0
    for (let i = msgs.length - 1; i >= 0 && msgs[i].ts > since; i--) if (msgs[i].from !== this.selfId) n++
    return n
  }

  connectDemo(protocol: Protocol) {
    const s = mockSession(protocol)
    this.session = { info: s.info, caps: capabilitiesFor(protocol), transport: 'Demo' }
    this.nodes = s.nodes
    this.channels = s.channels
    this.messages = s.messages
    this.samples = s.samples
    this.remote = {}
    this.results = {}
    this.busy = {}
    this.traceHistory = {}
    this.foundRoutes = {}
    this.#demo = new DemoRadio(protocol, s.configs)
    void this.#demo.init()
    this.dmPeers = [...new Set(s.messages.filter((m) => m.thread.startsWith('dm:')).map((m) => m.thread.slice(3)))]
    // Mark everything older than ~3h as read so unread badges look realistic.
    const cutoff = Date.now() - 3 * 3_600_000
    this.lastRead = Object.fromEntries([...this.byThread.keys()].map((k) => [k, cutoff]))
    this.traceroutes = {}
    this.channelHeard = {}
    for (const m of s.messages)
      if (m.thread.startsWith('ch:') && m.from !== this.selfId) this.#heardOn(m.thread, m.from, m.ts)
    if (protocol === 'meshtastic')
      for (const n of s.nodes) if (n.id !== this.selfId && n.lastHeard) this.#heardOn('ch:0', n.id, n.lastHeard)
    this.view = 'messages'
    this.activeThread = 'ch:0'
    this.selectedNode = null
    this.log = []
    this.markRead('ch:0')
    this.pushLog(`Connected (demo) · ${protocol} · ${s.nodes.length} nodes · ${s.channels.length} channels`)
    this.#stopTimers()
    this.#timers.push(setInterval(() => (this.now = Date.now()), 1000))
    this.#scheduleLive()
  }

  #stopTimers() {
    this.#timers.forEach(clearInterval)
    this.#timers = []
  }

  #heardOn(thread: string, nodeId: string, ts: number) {
    this.channelHeard[thread] ??= {}
    const ch = this.channelHeard[thread] // the proxy, not the object literal
    if ((ch[nodeId] ?? 0) < ts) ch[nodeId] = ts
  }

  /** Demo: simulate mesh traffic — nodes being heard and occasional messages. */
  #scheduleLive() {
    const t = setTimeout(() => {
      if (!this.session) return
      const peers = this.nodes.filter((n) => n.id !== this.selfId)
      const n = peers[Math.floor(Math.random() * peers.length)]
      if (n.ignored) return this.#scheduleLive()
      n.lastHeard = Date.now()
      if (this.protocol === 'meshtastic') this.#heardOn('ch:0', n.id, n.lastHeard)
      if (n.hops === 0) n.snr = Math.round((Math.random() * 22 - 15) * 4) / 4
      if (Math.random() < 0.3 && (this.protocol === 'meshtastic' || n.kind === 'chat')) {
        const ch = this.channels[Math.random() < 0.6 ? 0 : Math.floor(Math.random() * this.channels.length)]
        const isMt = this.protocol === 'meshtastic'
        const hops = n.hops ?? 1
        const direct = this.nodes.filter((x) => x.hops === 0 && x.id !== this.selfId)
        const relay = hops === 0 ? n.id : direct[Math.floor(Math.random() * direct.length)]?.id
        this.messages.push({
          id: `rx-${Date.now()}`,
          thread: `ch:${ch.index}`,
          from: n.id,
          text: ['copy that', 'anyone near the bay?', 'test 1 2 3', 'good morning mesh', 'heard you loud and clear'][
            Math.floor(Math.random() * 5)
          ],
          ts: Date.now(),
          status: 'received',
          hops,
          hopStart: isMt ? Math.max(hops, 3) : undefined,
          relay: isMt && relay ? relayByte(relay) : undefined,
          packetId: isMt ? Math.floor(Math.random() * 2 ** 31) + 1 : undefined,
          snr: Math.round((Math.random() * 20 - 14) * 4) / 4,
          rssi: isMt ? Math.round(-128 + Math.random() * 55) : undefined,
        })
        this.#heardOn(`ch:${ch.index}`, n.id, Date.now())
        if (this.activeThread === `ch:${ch.index}` && this.view === 'messages') this.markRead(`ch:${ch.index}`)
      }
      this.#scheduleLive()
    }, 1500 + Math.random() * 3500)
    this.#timers.push(t)
  }

  /** Real radio over Web Serial. Without a port, asks the user to pick one. */
  /** Set while trying to get back to the last radio after a drop or a reload. */
  reconnecting = $state<{ name: string; attempt: number } | null>(null)
  #reconnectGen = 0
  #expectNodeId: string | undefined

  /**
   * Opens a port and connects. With `expectNodeId`, a radio with another node id is
   * disconnected again (ports sharing USB ids cannot be told apart beforehand).
   * Returns whether a radio is connected.
   */
  async connectSerial(port?: SerialPort, opts: { expectNodeId?: string; reconnect?: boolean } = {}): Promise<boolean> {
    await this.#begin(opts, 'Opening port…')
    const gen = this.#connectGen
    try {
      port ??= await navigator.serial.requestPort()
    } catch {
      if (gen === this.#connectGen) this.connecting = null // picker cancelled
      return false
    }
    if (gen !== this.#connectGen) return false
    const t = new SerialTransport(port)
    const usb = port.getInfo()
    return this.#run(
      t,
      opts,
      async (sink) => {
        await t.open()
        if (this.#transport !== t) throw new Error('superseded')
        return detectProtocol(t, sink)
      },
      (info) => saveLastRadio({ nodeId: info.nodeId, name: info.longName, vid: usb.usbVendorId, pid: usb.usbProductId, auto: true }),
    )
  }

  /** Connects to a radio on WiFi through meshmash-bridge. The bridge says which protocol it runs. */
  async connectBridge(radio: string, opts: { expectNodeId?: string; reconnect?: boolean; takeover?: boolean } = {}): Promise<boolean> {
    if (!__BRIDGE__) return false
    await this.#begin(opts, 'Connecting to the bridge…')
    const gen = this.#connectGen
    try {
      const { loadBridge, openBridgeRadio } = await import('./transport/bridge')
      const { transport, protocol } = await openBridgeRadio(loadBridge(), radio, {
        takeover: opts.takeover,
        onWait: (w) => {
          if (gen === this.#connectGen)
            this.connecting = w === 'prompt' ? 'Allow local network access in the browser prompt…' : 'Waiting for the bridge…'
        },
      })
      if (gen !== this.#connectGen) {
        void transport.close()
        return false
      }
      // No detection: probing a MeshCore TCP port with Meshtastic bytes stalls it.
      return this.#run(transport, opts, async () => ({ protocol }), (info) =>
        saveLastRadio({ nodeId: info.nodeId, name: info.longName, auto: true, via: { radio } }),
      )
    } catch (e) {
      if (gen !== this.#connectGen) return false
      const msg = e instanceof Error ? e.message : String(e)
      // In use by another window (e.g. a second tab): retrying would not help.
      const inUse = (e as { code?: number }).code === 4409
      if (inUse) this.#stopReconnect()
      if (opts.reconnect && !inUse) this.#log({ dir: 'info', kind: 'reconnect', summary: msg })
      else this.connectError = { text: msg, via: 'bridge' }
      this.connecting = null
      return false
    }
  }

  async #begin(opts: { reconnect?: boolean }, text: string) {
    if (!opts.reconnect) this.#stopReconnect()
    this.#connectGen++
    // A reconnect attempt may still hold a port; never run two connections at once.
    if (this.#transport) await this.#teardown()
    this.connectError = null
    this.connecting = opts.reconnect ? 'Reconnecting…' : text
    if (!opts.reconnect) this.log = []
  }

  /**
   * Starts the protocol client on a transport. With `expectNodeId`, a radio with another
   * node id is disconnected again (ports sharing USB ids cannot be told apart beforehand).
   * Returns whether a radio is connected.
   */
  async #run(
    t: Transport,
    opts: { expectNodeId?: string; reconnect?: boolean },
    start: (sink: RadioSink) => Promise<{ protocol: Protocol; probe?: Probe }>,
    remember: (info: RadioInfo) => void,
  ): Promise<boolean> {
    this.#transport = t
    this.#expectNodeId = opts.expectNodeId
    const sink = this.#sink(t)
    t.onClose = (reason) => sink.closed(reason)
    try {
      const { protocol, probe } = await start(sink)
      if (this.#transport !== t) throw new Error('superseded')
      this.#client = protocol === 'meshtastic' ? new MeshtasticClient(t, sink) : new MeshCoreClient(t, sink)
      await this.#client.start(probe)
      if (opts.expectNodeId && this.session?.info.nodeId !== opts.expectNodeId)
        throw new Error(`a different radio (${this.session?.info.longName}) is on this port`)
      remember(this.session!.info)
      this.#holdLock(this.session!.info.nodeId)
      return true
    } catch (e) {
      // Superseded by a newer connection: leave that one alone.
      if (this.#transport !== t) return false
      const msg = e instanceof Error ? e.message : String(e)
      if (opts.reconnect) this.#log({ dir: 'info', kind: 'reconnect', summary: msg })
      else this.connectError = { text: msg, via: viaOf(t) }
      this.connecting = null
      await this.#teardown()
      return false
    }
  }

  /** Reconnects to the last radio on page load, unless the user had disconnected it. */
  autoConnect() {
    const last = loadLastRadio()
    if (!last?.auto || !(last.via ? __BRIDGE__ : 'serial' in navigator)) return
    // Open in another tab of this site: start on the connect screen instead of competing for it.
    void openElsewhere(last.nodeId).then((open) => {
      if (!open) void this.#reconnect(0, 30_000)
    })
  }

  /** Marks the radio as open in this tab for as long as it stays connected. */
  #holdLock(nodeId: string) {
    this.#releaseLock?.()
    this.#releaseLock = null
    if (!('locks' in navigator)) return
    void navigator.locks.request(lockName(nodeId), { ifAvailable: true }, (lock) =>
      lock ? new Promise<void>((release) => (this.#releaseLock = release)) : undefined,
    )
  }

  async #reconnect(firstDelayMs: number, forMs: number) {
    const last = loadLastRadio()
    if (!last) return
    const gen = ++this.#reconnectGen
    const deadline = Date.now() + forMs
    for (let attempt = 1; gen === this.#reconnectGen && Date.now() < deadline; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 1 ? firstDelayMs : 3000))
      if (gen !== this.#reconnectGen) return
      this.reconnecting = { name: last.name, attempt }
      if (last.via) {
        if (await this.connectBridge(last.via.radio, { expectNodeId: last.nodeId, reconnect: true })) {
          this.reconnecting = null
          return
        }
        continue
      }
      for (const p of await candidatePorts(last)) {
        if (gen !== this.#reconnectGen) return
        if (await this.connectSerial(p, { expectNodeId: last.nodeId, reconnect: true })) {
          this.reconnecting = null
          return
        }
      }
    }
    if (gen === this.#reconnectGen) this.reconnecting = null
  }

  stopReconnect() {
    this.#stopReconnect()
  }

  #stopReconnect() {
    this.#reconnectGen++
    this.reconnecting = null
  }

  /** Development aid: writes raw bytes to the open port. */
  async debugWrite(bytes: Uint8Array | number[]) {
    const b = Uint8Array.from(bytes)
    this.#log({ dir: 'tx', kind: 'debug', summary: 'raw write', bytes: b })
    await this.#transport?.write(b)
  }

  get isDemo() {
    return !this.#client
  }

  #sink(t: Transport): RadioSink {
    const radioKey = () => this.session?.info.nodeId ?? ''
    const persist = (m: Message) => {
      if (radioKey()) void saveMessage(radioKey(), m).catch(() => {})
    }
    return sanitizeSink({
      info: (info, caps) => {
        this.session = { info, caps: { ...capabilitiesFor(info.protocol), ...caps }, transport: t.label }
        const proto = info.protocol === 'meshtastic' ? 'Meshtastic' : 'MeshCore'
        if (t instanceof SerialTransport) void rememberPortName(t.port, `${info.longName} · ${proto}`)
      },
      progress: (text) => {
        if (this.connecting !== null) this.connecting = text
      },
      node: (patch) => {
        const n = this.nodeById.get(patch.id)
        if (n) Object.assign(n, patch)
        else this.nodes.push({ longName: patch.id, shortName: '?', kind: 'client', ...patch })
        const v: Record<string, number> = {}
        for (const k of SAMPLED) if (typeof patch[k] === 'number' && !Number.isNaN(patch[k])) v[k] = patch[k]
        if (this.connecting === null && Object.keys(v).length) this.#sample(patch.id, v)
      },
      removeNode: (id) => {
        this.nodes = this.nodes.filter((n) => n.id !== id)
      },
      channels: (list) => {
        this.channels = list
      },
      message: (m) => {
        if (m.reaction) return this.#addReaction(m)
        if (this.messages.some((x) => x.id === m.id)) return
        this.messages.push(m)
        persist(m)
        const peer = m.thread.slice(3)
        if (m.thread.startsWith('dm:') && !this.dmPeers.includes(peer)) this.dmPeers = [peer, ...this.dmPeers]
        if (this.activeThread === m.thread && this.view === 'messages') this.markRead(m.thread)
      },
      updateMessage: (id, patch) => {
        const m = this.messages.find((x) => x.id === id)
        if (!m) return
        Object.assign(m, patch)
        persist(m)
      },
      heard: (nodeId, ts, channel) => {
        if (channel !== undefined) this.#heardOn(`ch:${channel}`, nodeId, ts)
      },
      traceroute: (r) => {
        const a = this.busy[r.nodeId]
        const started = a ? this.results[r.nodeId]?.[a]?.ts : undefined
        const tr = started ? { ...r, rttMs: r.ts - started } : r
        this.traceroutes[r.nodeId] = tr
        this.traceHistory[r.nodeId] = [tr, ...(this.traceHistory[r.nodeId] ?? [])].slice(0, 20)
        if (r.found) this.foundRoutes[r.nodeId] = { ts: r.ts, ...r.found }
        this.#saveNode(r.nodeId)
        if (a) this.#result(r.nodeId, a, 'ok', `${r.towards.length - 1} hop${r.towards.length === 2 ? '' : 's'}`)
      },
      actionResult: (nodeId, action, ok, text) => this.#result(nodeId, action, ok ? 'ok' : 'failed', text),
      remote: (nodeId, patch) => {
        this.remote[nodeId] = { ...this.remote[nodeId], ...patch }
        const v: Record<string, number> = {}
        for (const r of patch.telemetry?.readings ?? []) {
          const x = parseFloat(r.value)
          if (!Number.isNaN(x) && r.type !== 136) v[`${r.name} ch${r.channel}`] = x
        }
        if (Object.keys(v).length) this.#sample(nodeId, v)
        this.#saveNode(nodeId)
      },
      cliLine: (nodeId, dir, text) => {
        this.remote[nodeId] ??= {}
        const r = this.remote[nodeId]
        r.cli = [...(r.cli ?? []), { ts: Date.now(), dir, text }].slice(-200)
        this.#saveNode(nodeId)
      },
      log: (e) => this.#log(e),
      ready: async () => {
        // Wrong radio on a reconnect attempt: connectSerial disconnects it; never show it.
        if (this.#expectNodeId && this.session?.info.nodeId !== this.#expectNodeId) return
        const history = await loadMessages(radioKey()).catch(() => [] as Message[])
        const saved = await loadNodeData(radioKey()).catch(() => ({}))
        for (const [id, d] of Object.entries(saved)) {
          if (d.traces?.length) {
            this.traceHistory[id] = d.traces
            this.traceroutes[id] = d.traces[0]
          }
          if (d.route) this.foundRoutes[id] = d.route
          if (d.remote) this.remote[id] = d.remote
          if (d.samples) this.samples[id] = d.samples
        }
        // Outcome of sends interrupted by a disconnect is unknown; stop their spinners.
        for (const m of history) if (m.from === this.selfId && !m.settled) m.settled = true
        // History from before packet ids were stored: received Meshtastic messages carry it in their id.
        for (const m of history) {
          const id = m.packetId === undefined ? /^mt-![0-9a-f]{8}-(\d+)$/.exec(m.id)?.[1] : undefined
          if (id) m.packetId = Number(id)
        }
        const ids = new Set(this.messages.map((m) => m.id))
        this.messages = [...history.filter((m) => !ids.has(m.id)), ...this.messages].sort((a, b) => a.ts - b.ts)
        const dms = this.messages.filter((m) => m.thread.startsWith('dm:')).map((m) => m.thread.slice(3))
        this.dmPeers = [...new Set(dms)]
        // Threads never opened on this radio start as read.
        const read = loadLastRead(radioKey())
        this.lastRead = Object.fromEntries([...this.byThread.keys()].map((k) => [k, read[k] ?? Date.now()]))
        this.view = 'messages'
        this.activeThread = this.channels[0] ? `ch:${this.channels[0].index}` : null
        this.selectedNode = null
        this.connecting = null
        this.#stopTimers()
        this.#timers.push(setInterval(() => (this.now = Date.now()), 1000))
      },
      closed: (reason) => {
        if (this.#transport !== t) return
        this.#log({ dir: 'info', kind: 'transport', summary: `closed${reason ? `: ${reason}` : ''}` })
        const wasUp = !!this.session && !this.connecting
        if (wasUp && reason) this.connectError = { text: `Connection lost: ${reason}`, via: viaOf(t) }
        void this.#teardown()
        // USB drops (hub resets, replugs) and WiFi dropouts are common; keep trying for a while.
        if (wasUp && reason && !t.final) void this.#reconnect(1500, 10 * 60_000)
      },
    })
  }

  async #teardown() {
    this.#releaseLock?.()
    this.#releaseLock = null
    const c = this.#client
    const t = this.#transport
    this.#client = null
    this.#transport = null
    this.#reset()
    await c?.close().catch(() => {})
    await t?.close().catch(() => {})
  }

  #reset() {
    this.#stopTimers()
    this.#demo = null
    this.session = null
    this.nodes = []
    this.channels = []
    this.messages = []
    this.dmPeers = []
    this.channelEditor = null
    this.traceroutes = {}
    this.traceHistory = {}
    this.foundRoutes = {}
    this.busy = {}
    this.results = {}
    this.remote = {}
    this.samples = {}
    for (const t of this.#saveTimers.values()) clearTimeout(t)
    this.#saveTimers.clear()
    this.channelHeard = {}
  }

  disconnect() {
    this.#stopReconnect()
    this.#connectGen++
    this.connecting = null
    const last = loadLastRadio()
    if (last && this.session) saveLastRadio({ ...last, auto: false })
    void this.#teardown()
  }

  #log(e: Omit<LogEntry, 'ts'>) {
    this.log.push({ ts: Date.now(), ...e })
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX)
  }

  pushLog(text: string) {
    this.#log({ dir: 'info', kind: 'app', summary: text })
  }

  markRead(thread: ThreadKey) {
    this.lastRead[thread] = Date.now()
    if (this.session && !this.isDemo) saveLastRead(this.session.info.nodeId, this.lastRead)
  }

  openThread(thread: ThreadKey) {
    this.readMark = this.unread(thread) ? { thread, ts: this.lastRead[thread] ?? 0 } : null
    this.activeThread = thread
    this.view = 'messages'
    this.markRead(thread)
  }

  /** Opens a message's thread and scrolls to it. */
  showMessage(m: Message) {
    if (m.thread.startsWith('dm:') && !this.dmPeers.includes(m.thread.slice(3))) this.dmPeers = [m.thread.slice(3), ...this.dmPeers]
    this.openThread(m.thread)
    this.readMark = null
    this.focus = { id: m.id, at: Date.now() }
  }

  openDm(nodeId: string) {
    if (!this.dmPeers.includes(nodeId)) this.dmPeers = [nodeId, ...this.dmPeers]
    this.openThread(`dm:${nodeId}`)
  }

  closeDm(nodeId: string) {
    this.dmPeers = this.dmPeers.filter((id) => id !== nodeId)
    if (this.activeThread === `dm:${nodeId}`) this.activeThread = 'ch:0'
  }

  showNode(nodeId: string) {
    this.selectedNode = nodeId
    this.view = 'nodes'
  }

  showOnMap(nodeId: string) {
    this.selectedNode = nodeId
    this.mapFocus = { id: nodeId, n: (this.mapFocus?.n ?? 0) + 1 }
    this.view = 'map'
  }

  /** Reactions attach to the message they answer; unknown targets are dropped. */
  #addReaction(r: Message) {
    const target = this.messages.find((x) => x.thread === r.thread && x.packetId === r.replyTo)
    if (!target) return
    const list = target.reactions ?? []
    if (list.some((x) => x.from === r.from && x.emoji === r.text)) return
    // Assign, not push: state proxies wrap a copy of an array assigned to them.
    target.reactions = [...list, { emoji: r.text, from: r.from, ts: r.ts }]
    if (this.session) void saveMessage(this.session.info.nodeId, target).catch(() => {})
  }

  /** Meshtastic: react to a message with an emoji. */
  react(target: Message, emoji: string, hopLimit?: number) {
    if (target.packetId === undefined || (!this.#client && !this.#demo)) return
    const r: Message = { id: '', thread: target.thread, from: this.selfId, text: emoji, ts: Date.now(), status: 'sent', replyTo: target.packetId, reaction: true }
    this.#addReaction(r)
    if (!this.#client) return
    const id = `local-${Date.now()}-${++localSeq}`
    this.#client
      .sendText(target.thread, emoji, id, { replyTo: target.packetId, reaction: true, hopLimit })
      .catch((e) => this.#log({ dir: 'error', kind: 'react', summary: String(e) }))
  }

  /** hopLimit: Meshtastic override of the radio's default for this message. */
  send(thread: ThreadKey, text: string, replyTo?: Message, hopLimit?: number) {
    const id = `local-${Date.now()}-${++localSeq}`
    const msg: Message = { id, thread, from: this.selfId, text, ts: Date.now(), status: 'pending', repeats: 0, replyTo: replyTo?.packetId, hopLimit }
    // Demo: the packet id a Meshtastic radio would give it, so it can be replied to.
    if (this.#demo && this.protocol === 'meshtastic') msg.packetId = Math.floor(Math.random() * 2 ** 31) + 1
    this.messages.push(msg)
    this.markRead(thread)
    if (this.#client) {
      void saveMessage(this.session!.info.nodeId, msg).catch(() => {})
      this.#client.sendText(thread, text, id, { replyTo: replyTo?.packetId, hopLimit }).catch((e) => {
        const m = this.messages.find((x) => x.id === id)
        if (m) Object.assign(m, { status: 'failed', settled: true })
        this.#log({ dir: 'error', kind: 'send', summary: String(e) })
      })
      return
    }
    const isDm = thread.startsWith('dm:')
    // Updates are dropped if the message is gone (e.g. after disconnect).
    const later = (ms: number, fn: (m: Message) => void) =>
      setTimeout(() => {
        const m = this.messages.find((x) => x.id === id)
        if (m) fn(m)
      }, ms)

    // Demo: radio accepts, then rebroadcasts trickle in during the window.
    later(500, (m) => (m.status = 'sent'))
    // Meshtastic reports only the first rebroadcast (implicit ACK), so at most 1.
    // Zero hop: nobody relays, and no ACK is requested.
    const repeats = hopLimit === 0 ? 0 : Math.floor(Math.random() * (this.protocol === 'meshtastic' ? 2 : 5))
    for (let i = 0; i < repeats; i++)
      later(1200 + Math.random() * (REPEAT_WINDOW_MS - 3000), (m) => (m.repeats = (m.repeats ?? 0) + 1))
    if (isDm && hopLimit !== 0 && Math.random() < 0.8) later(2500 + Math.random() * 8000, (m) => (m.status = 'acked'))
    later(REPEAT_WINDOW_MS, (m) => {
      m.settled = true
      if (isDm && hopLimit !== 0 && m.status !== 'acked') m.status = 'failed'
    })
  }

  #result(nodeId: string, action: string, state: ActionResult['state'], text?: string): ActionResult {
    const r: ActionResult = { action, state, ts: Date.now(), text }
    this.results[nodeId] = { ...this.results[nodeId], [action]: r }
    if (state === 'pending') this.busy[nodeId] = action
    else if (this.busy[nodeId] === action) delete this.busy[nodeId]
    return r
  }

  /** The password goes only to the radio; it is not stored. */
  login(nodeId: string, password: string) {
    if (this.#demo) {
      this.#result(nodeId, 'login', 'pending')
      setTimeout(() => {
        this.remote[nodeId] = { ...this.remote[nodeId], login: { role: password ? 'admin' : 'guest', ts: Date.now() } }
        this.#result(nodeId, 'login', 'ok', password ? 'Logged in as admin' : 'Logged in as guest')
      }, 1200)
      return
    }
    if (!this.#client?.login) return
    const r = this.#result(nodeId, 'login', 'pending')
    setTimeout(() => {
      if (this.results[nodeId]?.login?.ts === r.ts) this.#result(nodeId, 'login', 'failed', 'No answer')
    }, REQUEST_TIMEOUT_MS)
    this.#client.login(nodeId, password).catch((e) => this.#result(nodeId, 'login', 'failed', String(e?.message ?? e)))
  }

  get canEditChannels() {
    return !!this.#client?.setChannel || !!this.#demo
  }

  /** Free channel slots. Meshtastic slot 0 is the primary channel and always in use. */
  get freeChannelSlots(): number[] {
    const used = new Set(this.channels.map((c) => c.index))
    const max = this.session?.caps.maxChannels ?? 0
    return Array.from({ length: max }, (_, i) => i).filter((i) => !used.has(i) && !(i === 0 && this.protocol === 'meshtastic'))
  }

  /** Opens the editor on a channel, or on the first free slot. */
  editChannel(index?: number) {
    if (index !== undefined) this.channelEditor = { index, isNew: false }
    else if (this.freeChannelSlots.length) this.channelEditor = { index: this.freeChannelSlots[0], isNew: true }
  }

  channelConfig(index: number): ChannelConfig | undefined {
    return this.#client ? this.#client.channelConfig?.(index) : this.#demo?.channelConfig(index)
  }

  /** Whether saving `next` deletes the slot's history: a new channel, or a different one. */
  replacesChannel(next: ChannelConfig, isNew: boolean) {
    return isNew || channelReplaced(this.protocol ?? 'meshcore', this.channelConfig(next.index), next)
  }

  /** Writes a channel; a new or different channel starts with an empty thread. */
  async saveChannel(next: ChannelConfig, isNew: boolean) {
    const client = this.#client
    const demo = this.#demo
    if (!client?.setChannel && !demo) throw new Error('Not supported')
    const replaced = this.replacesChannel(next, isNew)
    if (client?.setChannel) await client.setChannel(next, isNew)
    else this.channels = await demo!.setChannel(next)
    const thread: ThreadKey = `ch:${next.index}`
    if (replaced) this.#dropThread(thread)
    this.pushLog(`Channel ${next.index} saved`)
    this.channelEditor = null
    this.openThread(thread)
  }

  get canDeleteChannel() {
    const ed = this.channelEditor
    return (!!this.#client?.deleteChannel || !!this.#demo) && !!ed && !ed.isNew && !(ed.index === 0 && this.protocol === 'meshtastic')
  }

  get canSetHopLimit() {
    return !!this.#client?.setHopLimit || (!!this.#demo && this.protocol === 'meshtastic')
  }

  /** Sets the radio's hop limit, the default for everything it sends. */
  async setHopLimit(hops: number) {
    const client = this.#client
    if (!this.session || (!client?.setHopLimit && !this.#demo)) throw new Error('Not supported')
    if (client?.setHopLimit) await client.setHopLimit(hops)
    else await new Promise((r) => setTimeout(r, 600))
    this.session.caps.hopLimit = hops
    this.pushLog(`Hop limit set to ${hops}`)
  }

  /** Frees a channel slot and deletes its history. */
  async deleteChannel(index: number) {
    const client = this.#client
    const demo = this.#demo
    if (!client?.deleteChannel && !demo) throw new Error('Not supported')
    if (client?.deleteChannel) await client.deleteChannel(index)
    else this.channels = await demo!.deleteChannel(index)
    const thread: ThreadKey = `ch:${index}`
    this.#dropThread(thread)
    this.pushLog(`Channel ${index} deleted`)
    this.channelEditor = null
    if (this.activeThread === thread) this.activeThread = this.channels[0] ? `ch:${this.channels[0].index}` : null
  }

  /** Removes a thread's messages here and in storage. */
  #dropThread(thread: ThreadKey) {
    const gone = this.messages.filter((m) => m.thread === thread)
    if (gone.length) {
      this.messages = this.messages.filter((m) => m.thread !== thread)
      void deleteMessages(this.session!.info.nodeId, gone.map((m) => m.id)).catch(() => {})
    }
    delete this.channelHeard[thread]
    saveHopLimit(this.session!.info.nodeId, thread, null)
  }

  get canManageContacts() {
    return !!this.#client?.getContactSettings || (!!this.#demo && this.protocol === 'meshcore')
  }
  getContactSettings() {
    if (this.#demo) return Promise.resolve({ ...this.#demo.contactSettings })
    return this.#client?.getContactSettings?.() ?? Promise.reject(new Error('not supported'))
  }
  setContactSettings(s: ContactSettings) {
    if (this.#demo) return Promise.resolve(void (this.#demo.contactSettings = { ...s }))
    return this.#client?.setContactSettings?.(s) ?? Promise.reject(new Error('not supported'))
  }
  /** Resolves with the new contact's node id. */
  importContact(link: string) {
    if (this.#demo) return Promise.resolve().then(() => this.#demoImport(link))
    return this.#client?.importContact?.(link) ?? Promise.reject(new Error('not supported'))
  }

  #demoImport(link: string): string {
    const l = parseContactLink(link)
    if (!l) throw new Error('Not a meshcore://contact/add link')
    const id = l.publicKey.slice(0, 12)
    if (!this.nodeById.has(id)) {
      const kind = ({ 2: 'repeater', 3: 'room', 4: 'sensor' } as const)[l.type] ?? 'chat'
      this.nodes.push({ id, longName: l.name, shortName: initials(l.name), kind, publicKey: l.publicKey })
    }
    return id
  }

  cli(nodeId: string, text: string) {
    const node = this.nodeById.get(nodeId)
    if (this.#demo && node) {
      const line = (dir: 'out' | 'in', t: string) => {
        this.remote[nodeId] ??= {}
        const r = this.remote[nodeId]
        r.cli = [...(r.cli ?? []), { ts: Date.now(), dir, text: t }]
      }
      line('out', text)
      setTimeout(() => line('in', this.#demo?.cliReply(node, text) ?? ''), 700)
      return
    }
    this.#client?.cli?.(nodeId, text).catch((e) => this.#log({ dir: 'error', kind: 'cli', summary: String(e) }))
  }

  /** Coalesces samples less than a minute apart into one. */
  #sample(nodeId: string, v: Record<string, number>) {
    // A voltage of 0 means "not measured" on both protocols.
    for (const k of Object.keys(v)) if (/^voltage/i.test(k) && v[k] === 0) delete v[k]
    if (!Object.keys(v).length) return
    this.samples[nodeId] ??= []
    const list = this.samples[nodeId] // the proxy, not the array literal
    const last = list.at(-1)
    if (last && Date.now() - last.ts < 60_000) Object.assign(last.v, v)
    else list.push({ ts: Date.now(), v })
    if (list.length > SAMPLES_MAX) list.splice(0, list.length - SAMPLES_MAX)
    this.#saveNode(nodeId)
  }

  /** Debounced write of a node's traces, fetched data and samples. */
  #saveNode(nodeId: string) {
    const radio = this.session?.info.nodeId
    if (!radio || this.isDemo) return
    clearTimeout(this.#saveTimers.get(nodeId))
    this.#saveTimers.set(
      nodeId,
      setTimeout(() => {
        this.#saveTimers.delete(nodeId)
        const remote = this.remote[nodeId]
        void saveNodeData(radio, nodeId, {
          traces: this.traceHistory[nodeId],
          route: this.foundRoutes[nodeId],
          remote: remote && { ...remote, cli: redactCli(remote.cli).slice(-50) },
          samples: this.samples[nodeId],
        }).catch(() => {})
      }, 2000),
    )
  }

  runAction(action: string, nodeId: string) {
    const node = this.nodeById.get(nodeId)
    if (!node) return
    if (action === 'dm') return this.openDm(nodeId)
    if (this.#client) {
      if (REQUEST_ACTIONS.has(action)) {
        const r = this.#result(nodeId, action, 'pending')
        setTimeout(() => {
          if (this.results[nodeId]?.[action]?.ts === r.ts) this.#result(nodeId, action, 'failed', TIMEOUT_TEXT[action] ?? 'No answer')
        }, REQUEST_TIMEOUT_MS)
      }
      this.#client.action(action, nodeId, { route: $state.snapshot(this.foundRoutes[nodeId]) }).catch((e) => {
        this.#result(nodeId, action, 'failed', e instanceof Error ? e.message : String(e))
        this.#log({ dir: 'error', kind: action, summary: String(e) })
      })
      return
    }
    // Demo implementations.
    const demo = this.#demo
    if (!demo) return
    const isMt = this.protocol === 'meshtastic'
    /** Answers after a delay, like a request over the air. */
    const answer = (fn: () => string, ms = 1200 + Math.random() * 1500) => {
      this.#result(nodeId, action, 'pending')
      setTimeout(() => this.#demo === demo && this.#result(nodeId, action, 'ok', fn()), ms)
    }
    const setRemote = (patch: RemoteData) => (this.remote[nodeId] = { ...this.remote[nodeId], ...patch })
    const snr = () => Math.round((Math.random() * 20 - 12) * 4) / 4
    // Relays on the way: MeshCore repeaters, Meshtastic any node; hash = first id byte.
    const relays = (n: number) => {
      const pool = this.nodes.filter((x) => x.id !== nodeId && x.id !== this.selfId && (isMt ? x.kind !== 'client_mute' : x.kind === 'repeater'))
      return Array.from({ length: n }, (_, i) => pool[(i * 7 + nodeId.charCodeAt(1)) % pool.length].id)
    }
    const hashOf = (id: string) => id.slice(0, 2)
    const idOfHash = (h: string) => this.nodes.find((x) => x.id.startsWith(h) && x.kind === 'repeater')?.id ?? h
    const traced = (r: Omit<TracerouteResult, 'nodeId' | 'ts'>) =>
      answer(() => {
        const tr: TracerouteResult = { nodeId, ts: Date.now(), rttMs: 1500 + Math.floor(Math.random() * 4000), ...r }
        this.traceroutes[nodeId] = tr
        this.traceHistory[nodeId] = [tr, ...(this.traceHistory[nodeId] ?? [])].slice(0, 20)
        if (tr.found) this.foundRoutes[nodeId] = { ts: tr.ts, ...tr.found }
        return `${tr.towards.length - 1} hop${tr.towards.length === 2 ? '' : 's'}`
      })
    switch (action) {
      case 'advert-zero':
      case 'advert-flood':
      case 'send-nodeinfo':
      case 'send-position':
      case 'share': {
        const text = {
          'advert-zero': 'Zero-hop advert sent',
          'advert-flood': 'Flood advert sent',
          'send-nodeinfo': 'Node info broadcast',
          'send-position': 'Position broadcast',
          share: 'Advert re-sent to radios in direct range',
        }[action]
        this.pushLog(text)
        this.#result(nodeId, action, 'ok', text)
        return
      }
      case 'ignore':
        node.ignored = !node.ignored
        this.pushLog(`${node.ignored ? 'Ignored' : 'Unignored'} ${node.longName}`)
        return
      case 'favorite':
        node.favorite = !node.favorite
        return
      case 'remove':
        this.nodes = this.nodes.filter((n) => n.id !== nodeId)
        if (this.selectedNode === nodeId) this.selectedNode = null
        this.pushLog(`Removed ${node.longName}`)
        return
      case 'req-position':
        return answer(() => (node.position ? 'Position received' : 'No position shared'))
      case 'exchange-info':
        return answer(() => 'User info received')
      case 'req-telemetry':
        return answer(() => {
          if (!isMt) {
            const t = demo.telemetry(node)!
            setRemote({ telemetry: t })
            return `${t.readings.length} reading${t.readings.length === 1 ? '' : 's'}`
          }
          node.batteryPct = Math.min(100, Math.max(5, (node.batteryPct ?? 70) + Math.round(Math.random() * 4 - 2)))
          node.voltage = Math.round((3.3 + node.batteryPct / 110) * 100) / 100
          this.#sample(nodeId, { batteryPct: node.batteryPct, voltage: node.voltage })
          return 'Telemetry received'
        })
      case 'req-neighbours':
        return answer(() => {
          const nb = demo.neighbours(this.nodes, [nodeId, this.selfId])!
          setRemote({ neighbours: nb })
          return `${nb.total} neighbour${nb.total === 1 ? '' : 's'}`
        })
      case 'discover':
        return answer(() => {
          const nb = demo.neighbours(this.nodes, [this.selfId], true)!
          setRemote({ neighbours: nb })
          return `${nb.total} node${nb.total === 1 ? '' : 's'} in direct range`
        })
      case 'req-status':
        return answer(() => (setRemote({ status: demo.status(node) }), 'Status received'))
      case 'req-owner':
        return answer(() => (setRemote({ owner: demo.owner(node) }), 'Owner info received'))
      case 'reset-path':
        node.path = undefined
        node.hops = undefined
        this.#result(nodeId, action, 'ok', 'Path cleared; the next message floods')
        return
      case 'use-path': {
        const route = this.foundRoutes[nodeId]
        if (!route) return void this.#result(nodeId, action, 'failed', 'No discovered path')
        node.path = [...route.out]
        node.hops = route.out.length
        this.#result(nodeId, action, 'ok', 'Path saved')
        return
      }
      case 'traceroute': {
        const mid = relays(node.hops ?? 2)
        return traced({
          towards: [this.selfId, ...mid, nodeId],
          back: [nodeId, ...[...mid].reverse(), this.selfId],
          snrTowards: Array.from({ length: mid.length + 1 }, snr),
          snrBack: Array.from({ length: mid.length + 1 }, snr),
        })
      }
      case 'path-discovery': {
        const out = relays(Math.max(1, node.hops ?? 2)).map(hashOf)
        const back = [...out].reverse()
        return traced({
          towards: [this.selfId, ...out.map(idOfHash), nodeId],
          back: [nodeId, ...back.map(idOfHash), this.selfId],
          snrTowards: [],
          discovered: true,
          found: { out, back },
        })
      }
      case 'trace': {
        const found = this.foundRoutes[nodeId]
        const out = found?.out ?? node.path ?? []
        const back = found?.back ?? [...out].reverse()
        return traced({
          towards: [this.selfId, ...out.map(idOfHash), nodeId],
          back: [nodeId, ...back.map(idOfHash), this.selfId],
          snrTowards: Array.from({ length: out.length + 1 }, snr),
          snrBack: Array.from({ length: back.length + 1 }, snr),
          traced: { via: found ? 'found' : node.path ? 'stored' : 'direct', foundTs: found?.ts, hashBytes: 1 },
        })
      }
      default:
        this.pushLog(`${action} → ${node.longName} (not implemented in demo)`)
    }
  }
}

export const app = new AppState()
