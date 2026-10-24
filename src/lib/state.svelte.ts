import { capabilitiesFor, REPEAT_WINDOW_MS } from './model/capabilities'
import type {
  ActionResult,
  Capabilities,
  Channel,
  MeshNode,
  Message,
  Protocol,
  RadioInfo,
  RemoteData,
  ThreadKey,
  TracerouteResult,
} from './model/types'
import { mockSession } from './mock/mock'
import { detectProtocol } from './protocol/detect'
import { MeshCoreClient } from './protocol/meshcore/client'
import { MeshtasticClient } from './protocol/meshtastic/client'
import type { LogEntry, RadioClient, RadioSink } from './protocol/types'
import { loadMessages, saveMessage } from './store/db'
import { rememberPortName } from './transport/portNames'
import { SerialTransport } from './transport/serial'

export type View = 'messages' | 'nodes' | 'log'

const LOG_MAX = 5000
let localSeq = 0
/** Node actions that wait for an answer from the other node. */
const REQUEST_ACTIONS = new Set([
  'traceroute', 'req-position', 'req-telemetry', 'exchange-info',
  'path-discovery', 'trace', 'req-status', 'req-neighbours', 'req-owner',
])
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
  traceroutes = $state<Record<string, TracerouteResult>>({})
  /** Newest first, per node, this session. */
  traceHistory = $state<Record<string, TracerouteResult[]>>({})
  /** Pending request action per node id. */
  busy = $state<Record<string, string>>({})
  /** Latest result per node id and action. */
  results = $state<Record<string, Record<string, ActionResult>>>({})
  remote = $state<Record<string, RemoteData>>({})
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
    const ch = (this.channelHeard[thread] ??= {})
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
  async connectSerial(port?: SerialPort) {
    this.connectError = null
    this.connecting = 'Opening port…'
    this.log = []
    try {
      port ??= await navigator.serial.requestPort()
    } catch {
      this.connecting = null // picker cancelled
      return
    }
    const t = new SerialTransport(port)
    this.#transport = t
    const sink = this.#sink(t)
    try {
      await t.open()
      t.onClose = (reason) => sink.closed(reason)
      const { protocol, probe } = await detectProtocol(t, sink)
      this.#client = protocol === 'meshtastic' ? new MeshtasticClient(t, sink) : new MeshCoreClient(t, sink)
      await this.#client.start(probe)
    } catch (e) {
      this.connectError = e instanceof Error ? e.message : String(e)
      this.connecting = null
      await this.#teardown()
    }
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
      },
      removeNode: (id) => {
        this.nodes = this.nodes.filter((n) => n.id !== id)
      },
      channels: (list) => {
        this.channels = list
      },
      message: (m) => {
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
        if (a) this.#result(r.nodeId, a, 'ok', `${r.towards.length - 1} hop${r.towards.length === 2 ? '' : 's'}`)
      },
      actionResult: (nodeId, action, ok, text) => this.#result(nodeId, action, ok ? 'ok' : 'failed', text),
      remote: (nodeId, patch) => {
        this.remote[nodeId] = { ...this.remote[nodeId], ...patch }
      },
      cliLine: (nodeId, dir, text) => {
        const r = (this.remote[nodeId] ??= {})
        r.cli = [...(r.cli ?? []), { ts: Date.now(), dir, text }].slice(-200)
      },
      log: (e) => this.#log(e),
      ready: async () => {
        const history = await loadMessages(radioKey()).catch(() => [] as Message[])
        // Outcome of sends interrupted by a disconnect is unknown; stop their spinners.
        for (const m of history) if (m.from === this.selfId && !m.settled) m.settled = true
        const ids = new Set(this.messages.map((m) => m.id))
        this.messages = [...history.filter((m) => !ids.has(m.id)), ...this.messages].sort((a, b) => a.ts - b.ts)
        const dms = this.messages.filter((m) => m.thread.startsWith('dm:')).map((m) => m.thread.slice(3))
        this.dmPeers = [...new Set(dms)]
        this.lastRead = Object.fromEntries([...this.byThread.keys()].map((k) => [k, Date.now()]))
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
        if (this.session && reason) this.connectError = `Connection lost: ${reason}`
        void this.#teardown()
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
    this.channelHeard = {}
  }

  disconnect() {
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
  }

  openThread(thread: ThreadKey) {
    this.activeThread = thread
    this.view = 'messages'
    this.markRead(thread)
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

  send(thread: ThreadKey, text: string) {
    const id = `local-${Date.now()}-${++localSeq}`
    const msg: Message = { id, thread, from: this.selfId, text, ts: Date.now(), status: 'pending', repeats: 0 }
    this.messages.push(msg)
    this.markRead(thread)
    if (this.#client) {
      void saveMessage(this.session!.info.nodeId, msg).catch(() => {})
      this.#client.sendText(thread, text, id).catch((e) => {
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

  cli(nodeId: string, text: string) {
    this.#client?.cli?.(nodeId, text).catch((e) => this.#log({ dir: 'error', kind: 'cli', summary: String(e) }))
  }

  runAction(action: string, nodeId: string) {
    const node = this.nodeById.get(nodeId)
    if (!node) return
    if (action === 'dm') return this.openDm(nodeId)
    if (this.#client) {
      if (REQUEST_ACTIONS.has(action)) {
        const r = this.#result(nodeId, action, 'pending')
        setTimeout(() => {
          if (this.results[nodeId]?.[action]?.ts === r.ts) this.#result(nodeId, action, 'failed', 'No answer')
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
        this.pushLog('Advert sent (zero hop)')
        return
      case 'advert-flood':
        this.pushLog('Advert sent (flood)')
        return
      case 'send-nodeinfo':
        this.pushLog('Node info broadcast')
        return
      case 'send-position':
        this.pushLog('Position broadcast')
        return
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
