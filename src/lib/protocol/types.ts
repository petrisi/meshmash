import type {
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
  ThreadKey,
  TracerouteResult,
} from '../model/types'

export type LogDir = 'rx' | 'tx' | 'text' | 'info' | 'error'

export interface LogEntry {
  ts: number
  dir: LogDir
  /** Short type name, e.g. "FromRadio.node_info" or "RESP_CODE_CONTACT". */
  kind: string
  summary: string
  bytes?: Uint8Array
}

/** Callbacks a protocol client uses to publish what it learns. */
export interface RadioSink {
  info(info: RadioInfo, caps?: Partial<Capabilities>): void
  progress(text: string): void
  /** Insert or merge by id. */
  node(patch: Partial<MeshNode> & { id: string }): void
  removeNode(id: string): void
  channels(list: Channel[]): void
  message(m: Message): void
  updateMessage(id: string, patch: Partial<Message>): void
  /** A packet from nodeId was heard, optionally on a channel index. */
  heard(nodeId: string, ts: number, channel?: number): void
  traceroute(r: TracerouteResult): void
  /** Merge data fetched from a node. */
  remote(nodeId: string, patch: Omit<RemoteData, 'cli'>): void
  cliLine(nodeId: string, dir: 'out' | 'in', text: string): void
  /** Answer (or definite failure) for a request started by RadioClient.action. */
  actionResult(nodeId: string, action: string, ok: boolean, text?: string): void
  log(e: Omit<LogEntry, 'ts'>): void
  /** Initial download complete; UI can show the radio. */
  ready(): void
  closed(reason?: string): void
}

export interface Probe {
  /** Meshtastic want_config nonce sent during detection. */
  nonce: number
  /** Raw bytes received since the first probe. */
  received: Uint8Array[]
  /** Leading chunks of `received` whose console text detection already logged. */
  textLogged: number
}

/** What the app keeps about a node that an action may need. */
export interface ActionContext {
  /** Latest path discovery result. */
  route?: FoundRoute
}

export interface SendOptions {
  /** Meshtastic packet id being answered. */
  replyTo?: number
  /** Send as a reaction to `replyTo` (Meshtastic). */
  reaction?: boolean
  /** Meshtastic hop limit for this message instead of the radio default (0-7). */
  hopLimit?: number
}

export interface RadioClient {
  readonly protocol: Protocol
  /**
   * Runs the connect handshake and initial download. `probe` is what detection already
   * requested and received, so a slow radio is not asked twice.
   */
  start(probe?: Probe): Promise<void>
  close(): Promise<void>
  /** localId is the id the UI already gave the pending message. */
  sendText(thread: ThreadKey, text: string, localId: string, opts?: SendOptions): Promise<void>
  action(action: string, nodeId: string, ctx?: ActionContext): Promise<void>
  /** A channel slot's stored name and key; undefined when the slot is free. */
  channelConfig?(index: number): ChannelConfig | undefined
  /** Writes a channel, reads it back, and reports the new list through sink.channels. */
  setChannel?(c: ChannelConfig, isNew: boolean): Promise<void>
  /** Frees a channel slot, reads it back, and reports the new list through sink.channels. */
  deleteChannel?(index: number): Promise<void>
  /** Log in to a server node; the outcome arrives as an actionResult for 'login'. */
  login?(nodeId: string, password: string): Promise<void>
  /** MeshCore contact handling. */
  getContactSettings?(): Promise<ContactSettings>
  setContactSettings?(s: ContactSettings): Promise<void>
  /** Adds a contact from a meshcore://contact/add link. */
  importContact?(link: string): Promise<string>
  /** Send a CLI command to a server node we administer. */
  cli?(nodeId: string, text: string): Promise<void>
}
