import { capabilitiesFor } from './model/capabilities'
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

  view = $state<View>('messages')
  activeThread = $state<ThreadKey | null>(null)
  selectedNode = $state<string | null>(null)
  log = $state<{ ts: number; text: string }[]>([])

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
    this.view = 'messages'
    this.activeThread = 'ch:0'
    this.selectedNode = null
    this.log = []
    this.markRead('ch:0')
    this.pushLog(`Connected (demo) · ${protocol} · ${s.nodes.length} nodes · ${s.channels.length} channels`)
  }

  disconnect() {
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
    const msg: Message = {
      id: `local-${Date.now()}`,
      thread,
      from: this.selfId,
      text,
      ts: Date.now(),
      status: 'pending',
    }
    this.messages.push(msg)
    this.markRead(thread)
    const idx = this.messages.length - 1
    setTimeout(() => (this.messages[idx].status = 'sent'), 400)
    setTimeout(() => (this.messages[idx].status = Math.random() < 0.85 ? 'acked' : 'failed'), 2500)
  }

  /** Demo implementations of node actions. */
  runAction(action: string, nodeId: string) {
    const node = this.nodeById.get(nodeId)
    if (!node) return
    switch (action) {
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
