import { capabilitiesFor, REPEAT_WINDOW_MS } from './model/capabilities'
import type {
  ActionResult,
  Capabilities,
  Channel,
  ContactSettings,
  MeshNode,
  Message,
  Protocol,
  RadioInfo,
  RemoteData,
  Sample,
  ThreadKey,
  TracerouteResult,
} from './model/types'
import { mockSession } from './mock/mock'
import { detectProtocol } from './protocol/detect'
import { MeshCoreClient } from './protocol/meshcore/client'
import { MeshtasticClient } from './protocol/meshtastic/client'
import type { LogEntry, RadioClient, RadioSink } from './protocol/types'
import { loadMessages, loadNodeData, saveMessage, saveNodeData } from './store/db'
import { loadLastRead, saveLastRead } from './store/lastRead'
import { candidatePorts, loadLastRadio, saveLastRadio } from './transport/lastRadio'
import { rememberPortName } from './transport/portNames'
import { SerialTransport } from './transport/serial'

export type View = 'messages' | 'nodes' | 'log'

const LOG_MAX = 5000
let localSeq = 0
/** MeshNode fields kept as telemetry history. */
const SAMPLED = ['batteryPct', 'voltage', 'channelUtil', 'airUtilTx', 'snr', 'rssi'] as const
const SAMPLES_MAX = 1000
/** Node actions that wait for an answer from the other node. */
const REQUEST_ACTIONS = new Set([
  'traceroute', 'req-position', 'req-telemetry', 'exchange-info',
  'path-discovery', 'trace', 'req-status', 'req-neighbours', 'req-owner',
  'advert-zero', 'advert-flood', 'send-nodeinfo', 'send-position', 'use-path', 'discover', 'add-contact',
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
  log = $state<LogEntry[]>([])
  /** Set while a radio connection is being established. */
  connecting = $state<string | null>(null)
  connectError = $state<string | null>(null)
  #client: RadioClient | null = null
  #transport: SerialTransport | null = null
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
    if (!opts.reconnect) this.#stopReconnect()
    // A reconnect attempt may still hold a port; never run two connections at once.
    if (this.#transport) await this.#teardown()
    this.connectError = null
    this.connecting = opts.reconnect ? 'Reconnecting…' : 'Opening port…'
    if (!opts.reconnect) this.log = []
    try {
      port ??= await navigator.serial.requestPort()
    } catch {
      this.connecting = null // picker cancelled
      return false
    }
    const t = new SerialTransport(port)
    this.#transport = t
    this.#expectNodeId = opts.expectNodeId
    const sink = this.#sink(t)
    try {
      const superseded = () => {
        if (this.#transport !== t) throw new Error('superseded')
      }
      await t.open()
      superseded()
      t.onClose = (reason) => sink.closed(reason)
      const { protocol, probe } = await detectProtocol(t, sink)
      superseded()
      this.#client = protocol === 'meshtastic' ? new MeshtasticClient(t, sink) : new MeshCoreClient(t, sink)
      await this.#client.start(probe)
      if (opts.expectNodeId && this.session?.info.nodeId !== opts.expectNodeId)
        throw new Error(`a different radio (${this.session?.info.longName}) is on this port`)
      const info = this.session!.info
      const usb = port.getInfo()
      saveLastRadio({ nodeId: info.nodeId, name: info.longName, vid: usb.usbVendorId, pid: usb.usbProductId, auto: true })
      return true
    } catch (e) {
      // Superseded by a newer connection: leave that one alone.
      if (this.#transport !== t) return false
      const msg = e instanceof Error ? e.message : String(e)
      if (opts.reconnect) this.#log({ dir: 'info', kind: 'reconnect', summary: msg })
      else this.connectError = msg
      this.connecting = null
      await this.#teardown()
      return false
    }
  }

  /** Reconnects to the last radio on page load, unless the user had disconnected it. */
  autoConnect() {
    const last = loadLastRadio()
    if (last?.auto && 'serial' in navigator) void this.#reconnect(0, 30_000)
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

  #sink(t: SerialTransport): RadioSink {
    const radioKey = () => this.session?.info.nodeId ?? ''
    const persist = (m: Message) => {
      if (radioKey()) void saveMessage(radioKey(), m).catch(() => {})
    }
    return {
      info: (info, caps) => {
        this.session = { info, caps: { ...capabilitiesFor(info.protocol), ...caps }, transport: t.label }
        const proto = info.protocol === 'meshtastic' ? 'Meshtastic' : 'MeshCore'
        void rememberPortName(t.port, `${info.longName} · ${proto}`)
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
          if (d.remote) this.remote[id] = d.remote
          if (d.samples) this.samples[id] = d.samples
        }
        // Outcome of sends interrupted by a disconnect is unknown; stop their spinners.
        for (const m of history) if (m.from === this.selfId && !m.settled) m.settled = true
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
        if (wasUp && reason) this.connectError = `Connection lost: ${reason}`
        void this.#teardown()
        // USB drops (hub resets, replugs) are common; keep trying for a while.
        if (wasUp && reason) void this.#reconnect(1500, 10 * 60_000)
      },
    }
  }

  async #teardown() {
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
    this.session = null
    this.nodes = []
    this.channels = []
    this.messages = []
    this.dmPeers = []
    this.traceroutes = {}
    this.traceHistory = {}
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
    const last = loadLastRadio()
    if (last && this.session) saveLastRadio({ ...last, auto: false })
    void this.#teardown()
  }

  #log(e: Omit<LogEntry, 'ts'>) {
    this.log.push({ ts: Date.now(), ...e })
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX)
  }

  pushLog(text: string) {
    this.#log({ dir: 'info', kind: 'demo', summary: text })
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
  react(target: Message, emoji: string) {
    if (!this.#client || target.packetId === undefined) return
    const r: Message = { id: '', thread: target.thread, from: this.selfId, text: emoji, ts: Date.now(), status: 'sent', replyTo: target.packetId, reaction: true }
    this.#addReaction(r)
    const id = `local-${Date.now()}-${++localSeq}`
    this.#client
      .sendText(target.thread, emoji, id, { replyTo: target.packetId, reaction: true })
      .catch((e) => this.#log({ dir: 'error', kind: 'react', summary: String(e) }))
  }

  send(thread: ThreadKey, text: string, replyTo?: Message) {
    const id = `local-${Date.now()}-${++localSeq}`
    const msg: Message = { id, thread, from: this.selfId, text, ts: Date.now(), status: 'pending', repeats: 0, replyTo: replyTo?.packetId }
    this.messages.push(msg)
    this.markRead(thread)
    if (this.#client) {
      void saveMessage(this.session!.info.nodeId, msg).catch(() => {})
      this.#client.sendText(thread, text, id, { replyTo: replyTo?.packetId }).catch((e) => {
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
    const repeats = Math.floor(Math.random() * (this.protocol === 'meshtastic' ? 2 : 5))
    for (let i = 0; i < repeats; i++)
      later(1200 + Math.random() * (REPEAT_WINDOW_MS - 3000), (m) => (m.repeats = (m.repeats ?? 0) + 1))
    if (isDm && Math.random() < 0.8) later(2500 + Math.random() * 8000, (m) => (m.status = 'acked'))
    later(REPEAT_WINDOW_MS, (m) => {
      m.settled = true
      if (isDm && m.status !== 'acked') m.status = 'failed'
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
    if (!this.#client?.login) return
    const r = this.#result(nodeId, 'login', 'pending')
    setTimeout(() => {
      if (this.results[nodeId]?.login?.ts === r.ts) this.#result(nodeId, 'login', 'failed', 'No answer')
    }, REQUEST_TIMEOUT_MS)
    this.#client.login(nodeId, password).catch((e) => this.#result(nodeId, 'login', 'failed', String(e?.message ?? e)))
  }

  get canManageContacts() {
    return !!this.#client?.getContactSettings
  }
  getContactSettings() {
    return this.#client?.getContactSettings?.() ?? Promise.reject(new Error('not supported'))
  }
  setContactSettings(s: ContactSettings) {
    return this.#client?.setContactSettings?.(s) ?? Promise.reject(new Error('not supported'))
  }
  /** Resolves with the new contact's node id. */
  importContact(link: string) {
    return this.#client?.importContact?.(link) ?? Promise.reject(new Error('not supported'))
  }

  cli(nodeId: string, text: string) {
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
          remote: remote && { ...remote, cli: remote.cli?.slice(-50) },
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
      this.#client.action(action, nodeId).catch((e) => {
        this.#result(nodeId, action, 'failed', e instanceof Error ? e.message : String(e))
        this.#log({ dir: 'error', kind: action, summary: String(e) })
      })
      return
    }
    // Demo implementations.
    switch (action) {
      case 'advert-zero':
      case 'advert-flood':
      case 'send-nodeinfo':
      case 'send-position': {
        const text = { 'advert-zero': 'Zero-hop advert sent', 'advert-flood': 'Flood advert sent', 'send-nodeinfo': 'Node info broadcast', 'send-position': 'Position broadcast' }[action]
        this.pushLog(text)
        this.#result(nodeId, action, 'ok', text)
        return
      }
      case 'ignore':
        node.ignored = !node.ignored
        this.pushLog(`${node.ignored ? 'Ignored' : 'Unignored'} ${node.longName}`)
        return
      case 'dm':
        this.openDm(nodeId)
        return
      case 'favorite':
        node.favorite = !node.favorite
        return
      case 'traceroute':
      case 'trace':
      case 'path-discovery': {
        this.busy[nodeId] = action
        this.pushLog(`${action} → ${node.longName}`)
        setTimeout(() => {
          delete this.busy[nodeId]
          const hops = node.hops ?? 2
          const pool = this.nodes.filter((n) => n.id !== nodeId && n.id !== this.selfId && n.kind !== 'room')
          const mid = Array.from({ length: hops }, (_, i) => pool[(i * 7 + nodeId.length) % pool.length].id)
          const snr = () => Math.round((Math.random() * 20 - 12) * 4) / 4
          this.traceroutes[nodeId] = {
            nodeId,
            ts: Date.now(),
            towards: [this.selfId, ...mid, nodeId],
            back: [nodeId, ...[...mid].reverse(), this.selfId],
            snrTowards: Array.from({ length: hops + 1 }, snr),
            snrBack: Array.from({ length: hops + 1 }, snr),
          }
          this.pushLog(`${action} ← ${node.longName}: ${hops} hop(s)`)
        }, 1800)
        return
      }
      default:
        this.pushLog(`${action} → ${node.longName} (not implemented in demo)`)
    }
  }
}

export const app = new AppState()
