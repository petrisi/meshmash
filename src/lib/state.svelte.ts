import { capabilitiesFor, REPEAT_WINDOW_MS } from './model/capabilities'
import type {
  Capabilities,
  Channel,
  MeshNode,
  Message,
  Protocol,
  RadioInfo,
  ThreadKey,
  TracerouteResult,
} from './model/types'
import { mockSession } from './mock/mock'

export type View = 'messages' | 'nodes'

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
  busy = $state<Record<string, string>>({})
  /**
   * Per channel: node id → last time heard on that channel. Meshtastic counts any packet
   * (every packet carries a channel); MeshCore only channel messages.
   */
  channelHeard = $state<Record<string, Record<string, number>>>({})

  view = $state<View>('messages')
  activeThread = $state<ThreadKey | null>(null)
  selectedNode = $state<string | null>(null)
  log = $state<{ ts: number; text: string }[]>([])
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

  disconnect() {
    this.#stopTimers()
    this.session = null
    this.nodes = []
    this.channels = []
    this.messages = []
    this.dmPeers = []
  }

  pushLog(text: string) {
    this.log = [...this.log.slice(-199), { ts: Date.now(), text }]
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
    const id = `local-${Date.now()}`
    this.messages.push({ id, thread, from: this.selfId, text, ts: Date.now(), status: 'pending', repeats: 0 })
    this.markRead(thread)
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

  /** Demo implementations of node actions. */
  runAction(action: string, nodeId: string) {
    const node = this.nodeById.get(nodeId)
    if (!node) return
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
